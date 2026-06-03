const fs = require("fs");

const address = process.env.MAIL_ADDRESS;
const password = process.env.MAIL_PASSWORD;
const targetSubject = process.env.TARGET_SUBJECT;

if (!address || !password || !targetSubject) {
  throw new Error("Missing MAIL_ADDRESS, MAIL_PASSWORD, or TARGET_SUBJECT");
}

const api = "https://api.mail.tm";

async function request(path, options = {}) {
  const res = await fetch(`${api}${path}`, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

async function main() {
  const login = await request("/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, password }),
  });

  const token = login.token;

  const messages = await request("/messages", {
    headers: { Authorization: `Bearer ${token}` },
  });

  const matching = messages["hydra:member"]
    .filter(msg => msg.subject && msg.subject.includes(targetSubject))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (matching.length === 0) {
    throw new Error(`No email found with subject containing: ${targetSubject}`);
  }

  const latest = await request(`/messages/${matching[0].id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const content = [
    latest.subject || "",
    latest.intro || "",
    latest.text || "",
    latest.html ? latest.html.join("\n") : "",
  ].join("\n");

  const match = content.match(/\b\d{6}\b/);

  if (!match) {
    throw new Error("No 6 digit code found in latest matching email");
  }

  fs.writeFileSync("gmail_email.txt", match[0] + "\n");

  console.log(`Saved code to verification-code.txt`);
}

main();
