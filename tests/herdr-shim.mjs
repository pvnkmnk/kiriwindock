// Stands in for the "herdr" module under Node. Programs really run, on this computer: `on` is ignored.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

export const state = { appHome: "/nonexistent", platform: "linux" };
export const hcCalls = [];

export const exec = (cmd, args = [], opts = {}) => new Promise((res, rej) =>
  execFile(cmd, args, { cwd: opts.cwd, encoding: "utf8", maxBuffer: 8 << 20, timeout: opts.timeout ?? 30000 }, (e, stdout, stderr) =>
    e?.code === "ENOENT" ? rej(new Error(`cannot start ${cmd}: program not found`)) : res({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr })));

export const hc = async (args) => { hcCalls.push(args); return { code: 0, stdout: JSON.stringify({ address: "t1" }), stderr: "" }; };
export const readTextFile = (path) => readFile(path, "utf8").catch(() => null);
export const appHome = () => state.appHome;
export const window = () => ({ platform: state.platform });
