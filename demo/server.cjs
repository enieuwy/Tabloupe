// Disposable demo pages and an ICS subscription. No user data or external calls.
const http = require("node:http");
const port = Number(process.env.PORT || 18767);
const started = Date.now() - 60000;
let calendarActive = true;
const stamp = (time) => new Date(time).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const titles = { "/work": "Developer documentation", "/work-two": "Developer API reference", "/research": "Research notes", "/shop": "Shopping list", "/bookmark": "Saved reference bookmark", "/closed": "Closed session example" };
http.createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  if (request.method === "POST" && ["/calendar/start", "/calendar/end"].includes(url.pathname)) {
    calendarActive = url.pathname === "/calendar/start";
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ calendarActive }));
    return;
  }
  if (url.pathname === "/calendar.ics") {
    response.writeHead(200, { "Content-Type": "text/calendar", "Cache-Control": "no-store" });
    response.end(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Tabloupe//Disposable Demo//EN\r\nBEGIN:VEVENT\r\nUID:demo-work\r\nDTSTART:${stamp(started)}\r\nDTEND:${stamp(calendarActive ? Date.now() + 3600000 : started + 1000)}\r\nSUMMARY:Deep work\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`);
    return;
  }
  const title = titles[url.pathname] || "Tabloupe disposable demo";
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html><head><title>${title}</title></head><body style="font:20px system-ui;padding:4rem"><h1>${title}</h1><p>This page belongs to the isolated Tabloupe feature demo.</p><p>No live browser data is used.</p></body></html>`);
}).listen(port, "127.0.0.1", () => console.log(`Tabloupe demo ready http://127.0.0.1:${port}`));
