import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Command } from 'commander'
import { apiGet } from '../client'
import { isJsonMode, output, outputError } from '../output'
import { describeScope, findRole, findUser, registerRoleCommands, registerUserCommands } from './user'

const users = [
  {
    id: '0c5698c6-2751-44e9-b1a4-67a052baf2d1',
    email: 'Miranda@example.com',
    displayName: 'Miranda',
    disabledAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    hasPasskey: true,
    isAdmin: false,
    inviteExpiresAt: null,
  },
  {
    id: '0c56aaaa-0000-4000-8000-000000000000',
    email: 'edith@example.com',
    displayName: null,
    disabledAt: null,
    createdAt: '2026-09-02T00:00:00.000Z',
    hasPasskey: false,
    isAdmin: false,
    inviteExpiresAt: null,
  },
]

const apiGetMock = apiGet as ReturnType<typeof mock>

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride()
  registerUserCommands(program)
  registerRoleCommands(program)
  await program.parseAsync(args, { from: 'user' })
}

function routeGets(routes: Record<string, unknown>) {
  apiGetMock.mockImplementation(async (path: string) => {
    if (!(path in routes)) throw new Error(`unexpected GET ${path}`)
    return routes[path]
  })
}

describe('user CLI commands', () => {
  beforeEach(() => {
    apiGetMock.mockReset()
    ;(output as ReturnType<typeof mock>).mockClear()
    ;(outputError as ReturnType<typeof mock>).mockClear()
    ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(true)
  })

  it('finds a user by email case-insensitively, full id, or unique id prefix', () => {
    expect(findUser(users, 'miranda@EXAMPLE.com').id).toBe(users[0].id)
    expect(findUser(users, users[1].id).email).toBe('edith@example.com')
    expect(findUser(users, '0c5698').email).toBe('Miranda@example.com')
    expect(() => findUser(users, '0c56')).toThrow('ambiguous')
    expect(() => findUser(users, 'nobody@example.com')).toThrow('ficus user list')
  })

  it('describes where each assignment applies', () => {
    const names = new Map([['47a874b8-c3fd-43bb-bd56-40b9e9f8b378', 'Chlea']])
    expect(describeScope({ scope: 'system', squadId: null }, names)).toBe('instance-wide')
    expect(describeScope({ scope: 'squad_default', squadId: null }, names)).toBe('default for squads')
    expect(describeScope({ scope: 'squad', squadId: '47a874b8-c3fd-43bb-bd56-40b9e9f8b378' }, names)).toBe(
      'squad Chlea'
    )
    expect(describeScope({ scope: 'squad', squadId: 'ffffffff-0000-4000-8000-000000000000' }, names)).toBe(
      'squad ffffffff'
    )
  })

  it('get resolves the user, then reads their role assignments with squad names', async () => {
    routeGets({
      '/api/users': users,
      [`/api/users/${users[1].id}/roles`]: [
        {
          id: 'a1',
          roleId: 'r1',
          roleSlug: 'operator',
          roleName: 'Operator',
          scope: 'squad',
          squadId: 'squad-1',
          createdAt: '2026-09-02T00:00:00.000Z',
        },
      ],
      '/api/squads': [{ id: 'squad-1', name: 'Chlea' }],
    })
    await run(['user', 'get', 'edith@example.com'])
    expect(output).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'edith@example.com',
        state: 'invited',
        roles: [expect.objectContaining({ roleSlug: 'operator', squadName: 'Chlea' })],
      })
    )
  })

  it('permissions passes the squad through and --check answers with the shared matcher', async () => {
    routeGets({
      '/api/users': users,
      [`/api/users/${users[0].id}/permissions?squadId=47a874b8`]: {
        userId: users[0].id,
        email: users[0].email,
        disabled: false,
        squad: { id: '47a874b8-c3fd-43bb-bd56-40b9e9f8b378', name: 'Chlea' },
        roles: [],
        permissions: ['chat:*', 'deployments:*'],
      },
    })
    await run(['user', 'permissions', '0c5698', '--squad', '47a874b8', '--check', 'deployments:read'])
    expect(output).toHaveBeenCalledWith(
      expect.objectContaining({ check: 'deployments:read', allowed: true, grantedBy: ['deployments:*'] })
    )
  })

  it('--check never reports a disabled account as allowed', async () => {
    routeGets({
      '/api/users': users,
      [`/api/users/${users[0].id}/permissions`]: {
        userId: users[0].id,
        email: users[0].email,
        disabled: true,
        squad: null,
        roles: [],
        permissions: ['*'],
      },
    })
    await run(['user', 'permissions', users[0].id, '--check', 'deployments:read'])
    expect(output).toHaveBeenCalledWith(expect.objectContaining({ allowed: false, grantedBy: ['*'] }))
  })

  it('prints a readable check result outside JSON mode', async () => {
    ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(false)
    routeGets({
      '/api/users': users,
      [`/api/users/${users[1].id}/permissions?squadId=squad-1`]: {
        userId: users[1].id,
        email: users[1].email,
        disabled: false,
        squad: { id: 'squad-1', name: 'Chlea' },
        roles: [],
        permissions: ['chat:read'],
      },
    })
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      await run(['user', 'permissions', 'edith@example.com', '--squad', 'squad-1', '--check', 'deployments:read'])
      expect(log).toHaveBeenCalledWith('edith@example.com does NOT have deployments:read in squad Chlea')
    } finally {
      log.mockRestore()
    }
  })

  it('reports an unknown user through outputError instead of calling the permissions route', async () => {
    routeGets({ '/api/users': users })
    await run(['user', 'permissions', 'ghost@example.com'])
    expect(outputError).toHaveBeenCalledTimes(1)
    expect(apiGetMock).toHaveBeenCalledTimes(1)
  })
})

describe('role CLI commands', () => {
  const roles = [
    {
      id: 'r1',
      name: 'Operator',
      slug: 'operator',
      permissions: ['deployments:*'],
      appliesTo: 'user',
      isSystem: true,
      readOnly: false,
    },
  ]

  beforeEach(() => {
    apiGetMock.mockReset()
    ;(output as ReturnType<typeof mock>).mockClear()
    ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(true)
  })

  it('finds a role by slug or id', () => {
    expect(findRole(roles, 'operator').id).toBe('r1')
    expect(findRole(roles, 'r1').slug).toBe('operator')
    expect(() => findRole(roles, 'nope')).toThrow('ficus role list')
  })

  it('list can narrow to user-assignable roles', async () => {
    routeGets({ '/api/roles?assignableTo=user': roles })
    await run(['role', 'list', '--user-assignable'])
    expect(output).toHaveBeenCalledWith(roles)
  })

  it('get shows the named role', async () => {
    routeGets({ '/api/roles': roles })
    await run(['role', 'get', 'operator'])
    expect(output).toHaveBeenCalledWith(roles[0])
  })
})
