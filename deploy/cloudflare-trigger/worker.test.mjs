// node --test deploy/cloudflare-trigger/worker.test.mjs   (fake fetch; never calls GitHub)
import assert from "node:assert/strict";
import test from "node:test";
import { check, dispatch } from "./worker.js";

const ENV = { GITHUB_TOKEN: "t", REPO: "me/runner", WORKFLOW: "daily.yml", REF: "main" };
const reply = (status, body = "") => ({ status, text: async () => body, json: async () => JSON.parse(body) });

function fakeFetch(...replies) {
  const calls = [];
  const fn = async (url, init = {}) => { calls.push({ url, ...init }); return replies.shift(); };
  return { fn, calls };
}

test("dispatch presses Run with source=alarm on the main branch", async () => {
  const f = fakeFetch(reply(204));
  assert.equal(await dispatch(ENV, { fetchImpl: f.fn }), 1);
  assert.equal(f.calls[0].url, "https://api.github.com/repos/me/runner/actions/workflows/daily.yml/dispatches");
  assert.equal(f.calls[0].method, "POST");
  assert.deepEqual(JSON.parse(f.calls[0].body), { ref: "main", inputs: { source: "alarm" } });
  assert.equal(f.calls[0].headers.Authorization, "Bearer t");
});

test("dispatch retries GitHub hiccups, not bad tokens", async () => {
  const retry = fakeFetch(reply(502), reply(204));
  assert.equal(await dispatch(ENV, { fetchImpl: retry.fn, sleep: async () => {} }), 2);
  const bad = fakeFetch(reply(401, "Bad credentials"), reply(204));
  await assert.rejects(dispatch(ENV, { fetchImpl: bad.fn, sleep: async () => {} }), /HTTP 401: Bad credentials/);
  assert.equal(bad.calls.length, 1);
  await assert.rejects(dispatch({ ...ENV, GITHUB_TOKEN: "" }), /GITHUB_TOKEN/);
});

test("check reads the workflow without starting it", async () => {
  const f = fakeFetch(reply(200, JSON.stringify({ name: "hedge-fund daily", state: "active" })));
  assert.deepEqual(await check(ENV, { fetchImpl: f.fn }), { ok: true, detail: "me/runner · hedge-fund daily · active" });
  assert.equal(f.calls[0].method, undefined);
  const denied = fakeFetch(reply(404));
  assert.equal((await check(ENV, { fetchImpl: denied.fn })).ok, false);
});
