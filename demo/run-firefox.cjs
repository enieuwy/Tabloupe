#!/usr/bin/env node
// Real-browser proof driver. Refuses any profile outside this worktree's demo root.
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");

(async () => {
  const port = Number(process.argv[2]);
  if (!Number.isInteger(port) || port < 1024) throw new Error("Usage: node demo/run-firefox.cjs <web-ext debugger port>");
  const root = path.resolve(__dirname, "..");
  const { connectToFirefox: connect } = await import(pathToFileURL(path.join(root, "node_modules/web-ext/lib/firefox/rdp-client.js")));
  const client = await connect(port);
  console.log("Connected to disposable Firefox debugger on port", port);
  const request = client.request.bind(client);
  client.request = async (packet) => {
    let timeout;
    try {
      return await Promise.race([
        request(packet),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("RDP request timed out: " + JSON.stringify(packet))), 10000); }),
      ]);
    } finally { clearTimeout(timeout); }
  };
  const events = [];
  const listeners = new Set();
  const original = client._handleMessage.bind(client);
  client._handleMessage = (message) => {
    events.push(message);
    for (const listener of [...listeners]) listener(message);
    // web-ext's client predates console/watcher events. They are not replies.
    if (message.type && !message.error) return;
    return original(message);
  };
  const event = (predicate, milliseconds = 30000) => {
    const existing = events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const listener = (message) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(message);
      };
      const timer = setTimeout(() => { listeners.delete(listener); reject(new Error("Firefox event timed out")); }, milliseconds);
      listeners.add(listener);
    });
  };
  const evaluate = async (actor, text) => {
    const result = await client.request({ to: actor, type: "evaluateJSAsync", text });
    const evaluated = await event((message) => message.type === "evaluationResult" && message.resultID === result.resultID);
    if (evaluated.hasException) throw new Error(evaluated.exceptionMessage);
    return evaluated.result;
  };
  const run = async (actor, body, milliseconds) => {
    const token = randomUUID();
    await client.request({ to: actor, type: "startListeners", listeners: ["ConsoleAPI"] });
    const completed = event((message) => message.type === "consoleAPICall" && message.message?.arguments?.[0] === token, milliseconds);
    await evaluate(actor, `(async()=>{${body}\n})().then(value=>console.log(${JSON.stringify(token)},JSON.stringify({ok:true,value})),error=>console.log(${JSON.stringify(token)},JSON.stringify({ok:false,error:String(error),stack:error.stack})));undefined`);
    const result = JSON.parse((await completed).message.arguments[1]);
    if (!result.ok) throw new Error(result.error + "\n" + result.stack);
    return result.value;
  };
  try {
    const descriptor = await client.request({ to: "root", type: "getProcess", id: 0 });
    const { process: chrome } = await client.request({ to: descriptor.processDescriptor.actor, type: "getTarget" });
    const profile = await evaluate(chrome.consoleActor, 'Services.dirsvc.get("ProfD",Ci.nsIFile).path');
    if (!profile.startsWith(path.join(root, ".demo-profile") + path.sep)) throw new Error("Refusing non-demo Firefox profile: " + profile);
    console.log("Verified isolated profile:", profile);
    await evaluate(chrome.consoleActor, 'Services.prefs.setBoolPref("browser.urlbar.suggest.searches",false);Services.prefs.setBoolPref("browser.search.suggest.enabled",false);undefined');
    const addons = await client.request("listAddons");
    const addon = addons.addons.find((item) => item.id === "tabloupe@local");
    if (!addon?.temporarilyInstalled) throw new Error("The disposable temporary Tabloupe fixture is not installed");
    const watcher = await client.request({ to: addon.actor, type: "getWatcher" });
    await client.request({ to: watcher.actor, type: "watchTargets", targetType: "frame" });
    await evaluate(chrome.consoleActor, `gBrowser.selectedTab=gBrowser.addTrustedTab(${JSON.stringify(addon.manifestURL.replace(/manifest\.json$/, "options.html"))});undefined`);
    const target = (await event((message) => message.target?.url?.endsWith("/options.html"))).target;
    console.log("Exercising actual extension APIs");
    await run(target.consoleActor, 'const current=await browser.tabs.getCurrent();await browser.tabs.remove((await browser.tabs.query({})).filter(tab=>tab.id!==current.id).map(tab=>tab.id));for(const lens of (await browser.storage.local.get("lenses")).lenses||[])await browser.runtime.sendMessage({type:"lens-delete",lensId:lens.id});await browser.storage.local.set({focusSessionHistory:[]});return current.id;');
    const evidence = await run(target.consoleActor, await fs.readFile(path.join(__dirname, "exercise.js"), "utf8"), 180000);
    await fs.mkdir(path.join(__dirname, "evidence"), { recursive: true });
    await fs.writeFile(path.join(__dirname, "evidence", "firefox-api.json"), JSON.stringify({ ok: true, value: evidence }, null, 2) + "\n");
    console.log(JSON.stringify(evidence, null, 2));
    const timer = await run(target.consoleActor, `
      await browser.runtime.sendMessage({type:"lens-activate",view:{kind:"all"}});
      const started=await browser.runtime.sendMessage({type:"lens-timed-start",lensId:${JSON.stringify(evidence.workLensId)},minutes:1});
      if(!started.ok)throw new Error(JSON.stringify(started));
      const timerId=(await browser.storage.local.get("timedLensSession")).timedLensSession.id;
      await new Promise((resolve,reject)=>{
        const listener=(changes,area)=>{if(area==="local"&&changes.focusSessionHistory?.newValue?.some(row=>row.triggerId===timerId)){clearTimeout(timeout);browser.storage.onChanged.removeListener(listener);resolve();}};
        const timeout=setTimeout(()=>{browser.storage.onChanged.removeListener(listener);reject(new Error("Real one-minute timer did not expire"));},80000);
        browser.storage.onChanged.addListener(listener);
      });
      const state=await browser.storage.local.get(["timedLensSession","activeView","focusSessionHistory"]);
      if(state.activeView.kind!=="all"||!state.focusSessionHistory.some(row=>row.triggerId===timerId&&row.endedAt-row.startedAt>=59000))throw new Error("Timer did not restore All or record its span");
      return state;
    `, 90000);
    await fs.writeFile(path.join(__dirname, "evidence", "timer-firefox.json"), JSON.stringify({ ok: true, value: timer }, null, 2) + "\n");
    console.log("PASS: real one-minute alarm restored All and recorded timed history.");
  } finally {
    client.disconnect();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
