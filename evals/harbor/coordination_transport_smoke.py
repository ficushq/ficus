"""No inference: two fake concurrent requests through the native SDK and egress."""

import json
import shlex
from coordination import FicusCoordination, ROOT
from deepswe_network_smoke import probe_origin


class TransportProbe(FicusCoordination):
    async def run(self, instruction, environment, context):
        probe_origin(self.model_connection.base_url)
        denied = await environment.exec(
            "curl --noproxy '*' --max-time 5 -fsS https://raw.githubusercontent.com/gabeorlanski/scb-problems/main/README.md >/tmp/forbidden.txt"
        )
        assert denied.return_code != 0, "Public source must remain blocked"
        code = """import OpenAI from "/opt/ficus-harbor/runtime/node_modules/openai/index.mjs";
const client=new OpenAI({apiKey:"fake",baseURL:process.env.PROBE_URL,maxRetries:0});
const start=Date.now();
await Promise.all([0,1].map(async i=>{try {await client.responses.create({model:"fake",input:"x".repeat(1000000)});console.log(JSON.stringify({i,ok:true,ms:Date.now()-start}));}catch(e){console.log(JSON.stringify({i,ok:false,ms:Date.now()-start,error:e.message,cause:String(e.cause)}));}}));"""
        result = await environment.exec(
            f"{ROOT}/bin/bun -e {shlex.quote(code)}",
            env={"PROBE_URL": self.model_connection.base_url},
            timeout_sec=65,
        )
        (self.logs_dir / "transport.json").write_text(
            json.dumps(
                {
                    "code": result.return_code,
                    "stdout": result.stdout,
                    "stderr": result.stderr,
                    "public_source_blocked": True,
                },
                indent=2,
            )
        )
        rows = [json.loads(line) for line in (result.stdout or "").splitlines()]
        assert result.return_code == 0 and len(rows) == 2
        assert {row["i"] for row in rows} == {0, 1}
        assert all(row["ok"] for row in rows), rows
