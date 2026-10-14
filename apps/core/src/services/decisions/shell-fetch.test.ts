import { describe, expect, test } from 'bun:test'
import { fetchesOutsideContent, SHELL_FETCH_SOURCE_MAX, splitSimpleCommands } from './shell-fetch'

describe('fetchesOutsideContent: commands that read outside content', () => {
  test.each([
    // gh reading GitHub content
    ['gh issue view 123 -R owner/repo', 'gh issue view 123 (owner/repo)'],
    ['gh issue view 123 --repo=owner/repo --comments', 'gh issue view 123 (owner/repo)'],
    ['gh -R owner/repo issue list --state open --limit 50', 'gh issue list (owner/repo)'],
    ['gh issue ls', 'gh issue ls'],
    ['gh pr view 42 --json title,body,comments', 'gh pr view 42'],
    ['gh pr list --author @me', 'gh pr list'],
    ['gh pr diff 42', 'gh pr diff 42'],
    ['gh pr checks 42 --watch', 'gh pr checks 42'],
    ['gh api repos/owner/repo/issues/1/comments --paginate', 'gh api repos/owner/repo/issues/1/comments'],
    ["gh api graphql -f query='{ viewer { login } }'", 'gh api graphql'],
    ['gh api -X GET repos/o/r/pulls --jq ".[].title"', 'gh api repos/o/r/pulls'],
    ['gh search issues "prompt injection" --repo o/r', 'gh search issues prompt injection (o/r)'],
    ['gh release view v1.2.0', 'gh release view v1.2.0'],
    ['gh release list', 'gh release list'],
    ['gh repo view owner/repo', 'gh repo view owner/repo'],
    ['gh run view 987 --log-failed', 'gh run view 987'],
    ['gh gist view abc123', 'gh gist view abc123'],
    ['/usr/local/bin/gh pr view 1', 'gh pr view 1'],
    // HTTP clients, with the URL's host and path but never its query or credentials
    ['curl -s https://api.example.com/v1/items?token=SECRET', 'curl api.example.com/v1/items'],
    ['curl https://user:pass@example.com/', 'curl example.com'],
    ['curl example.com/page', 'curl example.com/page'],
    ['curl -sSL -H "Authorization: Bearer x" -o out.json https://example.com/a', 'curl example.com/a'],
    ['curl -X POST -d @body.json https://hooks.example.com/x', 'curl hooks.example.com/x'],
    ['curl --url https://example.com/u', 'curl example.com/u'],
    ['wget -qO- https://example.org/feed.xml', 'wget example.org/feed.xml'],
    ['wget -O page.html example.org/docs', 'wget example.org/docs'],
    ['http GET pie.dev/get', 'http pie.dev/get'],
    ['https example.com/api', 'https example.com/api'],
    ['xh get httpbin.org/json', 'xh httpbin.org/json'],
    ['aria2c https://example.com/file.tar.gz', 'aria2c example.com/file.tar.gz'],
    ['lynx -dump https://example.com/', 'lynx example.com'],
    ['w3m -dump https://example.com/news', 'w3m example.com/news'],
    // A URL we can't resolve is screened, naming the variable rather than its value
    ['curl -fsS "$API_URL/issues"', 'curl $API_URL/issues'],
    ['curl $(cat url.txt)', 'curl $(…)'],
    ['curl -fsS "$SERVER"', 'curl $SERVER'],
    ['curl localhost:3000/x $OTHER', 'curl localhost:3000/x'],
    // Pipes, lists and subshells
    ['curl -s https://api.example.com/x | jq .', 'curl api.example.com/x'],
    ['cd repo && gh pr view 5 && echo done', 'gh pr view 5'],
    ['npm test; curl -s https://example.com', 'curl example.com'],
    ['false || curl https://example.com/fallback', 'curl example.com/fallback'],
    ['(cd /tmp; curl https://example.com/sub)', 'curl example.com/sub'],
    ['echo "title: $(gh pr view 3 --json title -q .title)"', 'gh pr view 3'],
    ['echo `curl -s https://example.com/bt`', 'curl example.com/bt'],
    ['diff <(curl -s https://a.example/x) <(curl -s https://b.example/x)', 'curl a.example/x, curl b.example/x'],
    ['curl https://example.com/a & curl https://example.com/a', 'curl example.com/a'],
    ['curl -s https://example.com 2>&1 | head -50', 'curl example.com'],
    ['gh pr view 7 |& tee out.txt', 'gh pr view 7'],
    ['if curl -sf https://example.com/health; then echo ok; fi', 'curl example.com/health'],
    ['for u in a b; do curl -s https://example.com/$u; done', 'curl example.com/$u'],
    ['git status\ngh issue view 9', 'gh issue view 9'],
    // Wrappers and assignments
    ['GH_TOKEN=x gh api user', 'gh api user'],
    ['env VAR=x curl https://example.com/env', 'curl example.com/env'],
    ['env -i PATH=/bin curl https://example.com/i', 'curl example.com/i'],
    ['sudo curl https://example.com/root', 'curl example.com/root'],
    ['sudo -u deploy -E wget https://example.com/w', 'wget example.com/w'],
    ['time gh pr list', 'gh pr list'],
    ['timeout 30 curl https://example.com/slow', 'curl example.com/slow'],
    ['timeout -s KILL 5s curl https://example.com/k', 'curl example.com/k'],
    ['nice -n 10 nohup curl https://example.com/n', 'curl example.com/n'],
    ['cat urls.txt | xargs -n 1 curl -s', 'curl'],
    ['xargs -I{} curl -s https://example.com/{} < ids', 'curl example.com/{}'],
    ['\\curl https://example.com/alias', 'curl example.com/alias'],
    ["bash -c 'curl -s https://example.com/inner | jq .'", 'curl example.com/inner'],
    ['sh -lc "gh issue view 4"', 'gh issue view 4'],
    ['eval "curl https://example.com/eval"', 'curl example.com/eval'],
    // Quoted arguments stay one word
    ["curl -H 'X-Note: a | b && c' https://example.com/q", 'curl example.com/q'],
  ])('%p → %p', (command, source) => {
    expect(fetchesOutsideContent(command)).toEqual({ source })
  })
})

describe('fetchesOutsideContent: commands that do not', () => {
  test.each([
    // Everyday work
    'bun test',
    'npm run build && npm test',
    'git status',
    'git log --oneline -20',
    'git show HEAD~1',
    'git clone https://github.com/o/r.git',
    'git fetch origin && git log origin/main',
    'ls -la /tmp',
    "sed -i 's/a/b/' file.ts",
    'cat README.md | grep curl',
    'rg "gh pr view" src',
    // gh writes and housekeeping print our own text
    'gh pr create --title "Fix" --body "Calls curl https://example.com"',
    'gh pr merge 5 --squash',
    'gh pr comment 5 --body "lgtm"',
    'gh pr edit 5 --add-label bug',
    'gh issue create --title t --body b',
    'gh issue edit 3 --title new',
    'gh issue close 3',
    'gh issue comment 3 --body hi',
    'gh auth status',
    'gh auth login --with-token',
    'gh repo clone o/r',
    'gh run list',
    'gh release create v1',
    'gh',
    // Words that only mention a fetcher
    'echo curl https://example.com',
    'echo "gh issue view 1"',
    "printf '%s' 'curl https://example.com'",
    'which curl',
    'command -v gh',
    'type wget',
    'man curl',
    '# curl https://example.com',
    'ls # then gh pr view 1',
    // Fetchers with nothing to fetch
    'curl --version',
    'wget --help',
    // Only this machine
    'curl -s http://localhost:3000/api/health',
    'curl 127.0.0.1:8080/metrics',
    'curl -s http://[::1]:4000/',
    'http :3000/api/items',
    'wget -qO- http://app.localhost/x',
    // Text browsers that do not dump
    'lynx https://example.com',
    // Package runners are out of scope
    'npx some-fetcher https://example.com',
    'bunx wrangler whoami',
    // Here-document bodies are data
    'gh pr create --body "$(cat <<\'EOF\'\ncurl https://example.com/in-body\ngh issue view 1\nEOF\n)"',
    'cat > notes.md <<EOF\ncurl https://example.com\nEOF\necho ok',
    'cat <<-END\n\tgh pr view 1\n\tEND',
    // A here-string is input, not a command
    'grep -c x <<< "curl https://example.com"',
    // Redirection targets are files, not commands
    'echo hi > curl',
    '',
    '   ',
  ])('%p', (command) => {
    expect(fetchesOutsideContent(command)).toBeNull()
  })
})

describe('the shell parser', () => {
  test('splits on operators outside quotes and drops redirections', () => {
    expect(splitSimpleCommands(`a 'b | c' "d && e" | f 2>/dev/null >> log && g; h || i &`)).toEqual([
      ['a', 'b | c', 'd && e'],
      ['f'],
      ['g'],
      ['h'],
      ['i'],
    ])
  })

  test('command substitutions are their own commands, and leave a placeholder', () => {
    expect(splitSimpleCommands('echo "x $(gh pr view 1) y" z')).toEqual([
      ['gh', 'pr', 'view', '1'],
      ['echo', 'x $(…) y', 'z'],
    ])
  })

  test('an unclosed quote or substitution still yields what came before', () => {
    expect(fetchesOutsideContent('curl https://example.com/x "unterminated')).toEqual({
      source: 'curl example.com/x',
    })
    expect(fetchesOutsideContent('echo $(curl https://example.com/open')).toEqual({ source: 'curl example.com/open' })
  })

  test('the source is capped', () => {
    const long = `curl https://example.com/${'a'.repeat(400)}`
    const match = fetchesOutsideContent(long)!
    expect(match.source.length).toBe(SHELL_FETCH_SOURCE_MAX)
    expect(match.source).toEndWith('…')
  })

  test('many fetchers in one command are all named, once each', () => {
    expect(fetchesOutsideContent('gh pr view 1; gh pr view 1; curl https://example.com/z')).toEqual({
      source: 'gh pr view 1, curl example.com/z',
    })
  })
})
