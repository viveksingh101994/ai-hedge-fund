// Presses "Run workflow" on the runner repo at 08:00 UTC on weekdays.
// GET /check confirms the token can see the workflow, without starting a run.

const API = "https://api.github.com";

function headers(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "hedge-fund-alarm",
  };
}

const workflowUrl = (env) => `${API}/repos/${env.REPO}/actions/workflows/${env.WORKFLOW}`;

export async function dispatch(env, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN secret is not set");
  let last = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const resp = await fetchImpl(`${workflowUrl(env)}/dispatches`, {
      method: "POST",
      headers: { ...headers(env), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: env.REF, inputs: { source: "alarm" } }),
    });
    if (resp.status === 204) return attempt;
    last = `HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`;
    if (resp.status < 500 && resp.status !== 429) break;     // a bad token or name won't fix itself
    await sleep(attempt * 5000);
  }
  throw new Error(`GitHub refused to start the workflow: ${last}`);
}

export async function check(env, { fetchImpl = fetch } = {}) {
  if (!env.GITHUB_TOKEN) return { ok: false, detail: "GITHUB_TOKEN secret is not set" };
  const resp = await fetchImpl(workflowUrl(env), { headers: headers(env) });
  if (resp.status !== 200) return { ok: false, detail: `GitHub answered HTTP ${resp.status}; check the token's repo and Actions permission` };
  const wf = await resp.json();
  return { ok: wf.state === "active", detail: `${env.REPO} · ${wf.name} · ${wf.state}` };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env).then((n) => console.log(`workflow started (attempt ${n})`)));
  },
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/check") return new Response("hedge-fund alarm\n", { status: 404 });
    const result = await check(env);
    return Response.json(result, { status: result.ok ? 200 : 500 });
  },
};
