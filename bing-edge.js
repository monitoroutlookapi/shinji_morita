const { chromium } = require("playwright");

const email = process.env.MS_EMAIL;
const password = process.env.MS_PASSWORD;
const recoveryEmail = process.env.MS_RECOVERY_EMAIL;
const mailAddress = process.env.MAIL_ADDRESS;
const mailPassword = process.env.MAIL_PASSWORD;
const targetSubject = process.env.TARGET_SUBJECT || "Personal Microsoft account security code";

if (!email || !password || !recoveryEmail) {
  throw new Error("Missing MS_EMAIL, MS_PASSWORD, or MS_RECOVERY_EMAIL");
}

if (!mailAddress || !mailPassword) {
  throw new Error("Missing MAIL_ADDRESS or MAIL_PASSWORD");
}

async function snap(page, name) {
  await page.screenshot({ path: name, fullPage: true }).catch(() => {});
}

async function clickText(page, text, required = false) {
  const el = page.getByText(text, { exact: false }).first();

  if (await el.isVisible().catch(() => false)) {
    console.log(`Clicking text: ${text}`);
    await el.click();
    return true;
  }

  if (required) {
    await snap(page, `error-missing-${text.replace(/\s+/g, "-")}.png`);
    throw new Error(`Could not find text: ${text}`);
  }

  return false;
}

async function clickPrimaryButton(page, label) {
  const btn = page
    .locator(
      'button[data-testid="primaryButton"], button[type="submit"], input[type="submit"], #idSIButton9'
    )
    .first();

  await btn.waitFor({ state: "visible" });
  console.log(`Clicking primary button: ${label}`);
  await btn.click();
}

async function mailRequest(path, options = {}) {
  const res = await fetch(`https://api.mail.tm${path}`, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`mail.tm ${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

async function fetchVerificationCode() {
  console.log("Logging in to mail.tm...");

  const login = await mailRequest("/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: mailAddress, password: mailPassword }),
  });

  const token = login.token;

  for (let i = 0; i < 40; i++) {
    console.log(`Checking inbox for code... attempt ${i + 1}/40`);

    const messages = await mailRequest("/messages", {
      headers: { Authorization: `Bearer ${token}` },
    });

    const matching = messages["hydra:member"]
      .filter(msg => msg.subject && msg.subject.includes(targetSubject))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    if (matching.length > 0) {
      const latest = await mailRequest(`/messages/${matching[0].id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      const content = [
        latest.subject || "",
        latest.intro || "",
        latest.text || "",
        latest.html ? latest.html.join("\n") : "",
      ].join("\n");

      const match = content.match(/\b\d{6}\b/);

      if (match) {
        console.log(`Found verification code: ${match[0]}`);
        return match[0];
      }
    }

    await sleep(15000);
  }

  throw new Error("Timed out waiting for verification code email (10 min).");
}

// Dismiss quick note and stay signed in screens in a loop until none remain
async function dismissInterstitials(page, snapPrefix = "interstitial") {
  for (let i = 0; i < 5; i++) {
    const body = await page.locator("body").innerText().catch(() => "");

    if (/quick note about your Microsoft account/i.test(body)) {
      console.log("Detected 'Quick note' screen. Clicking OK...");
      await snap(page, `${snapPrefix}-quick-note.png`);

      // Try multiple selectors for the OK button
      const okBtn = page.locator(
        'button:has-text("OK"), input[value="OK"], #iNext, button#idSIButton9'
      ).first();

      if (await okBtn.isVisible().catch(() => false)) {
        await okBtn.scrollIntoViewIfNeeded();
        await okBtn.click({ force: true });
      } else {
        // Last resort: primary button
        await clickPrimaryButton(page, "quick note OK");
      }

      await page.waitForTimeout(5000);
      continue;
    }

    if (/Stay signed in/i.test(body)) {
      console.log("Detected 'Stay signed in?' screen. Clicking Yes...");
      await snap(page, `${snapPrefix}-stay-signed-in.png`);
      await clickText(page, "Yes", true);
      await page.waitForTimeout(5000);
      continue;
    }

    // No more interstitials
    return body;
  }

  return await page.locator("body").innerText().catch(() => "");
}

// Get a random word using wordnik-style approach with a fallback word list
function getRandomWord() {
  const words = [
    "apple","brave","cloud","dream","eagle","flame","grace","honey",
    "ivory","jewel","karma","lemon","magic","noble","ocean","pearl",
    "quest","river","stone","tiger","ultra","vivid","wheat","xenon",
    "youth","zebra","amber","blaze","coral","dusk","ember","frost",
    "globe","haven","iris","jade","knoll","lunar","maple","nova",
    "orbit","prism","quartz","ridge","solar","thorn","umbra","vale",
    "winds","xylem","yield","zonal"
  ];
  return words[Math.floor(Math.random() * words.length)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: false,
    slowMo: 400,
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(90000);

  try {
    console.log("1. Opening Microsoft login");
    await page.goto("https://login.live.com/", {
      waitUntil: "domcontentloaded",
    });
    await snap(page, "01-login-page.png");

    console.log("2. Entering Microsoft email");
    const emailBox = page
      .locator('input#usernameEntry, input[name="loginfmt"], input[type="email"]')
      .first();

    await emailBox.waitFor({ state: "visible" });
    await emailBox.click();
    await emailBox.fill(email);
    await snap(page, "02-ms-email-filled.png");

    await clickPrimaryButton(page, "email next");
    await page.waitForTimeout(5000);
    await snap(page, "03-after-email-next.png");

    console.log("3. Choosing Use your password");
    await clickText(page, "Use your password", true);
    await page.waitForTimeout(4000);
    await snap(page, "04-after-use-password.png");

    console.log("4. Entering password");
    const passwordBox = page
      .locator('input#passwordEntry, input[name="passwd"], input[type="password"]')
      .first();

    await passwordBox.waitFor({ state: "visible" });
    await passwordBox.click();
    await passwordBox.fill("");
    await passwordBox.type(password, { delay: 80 });
    await snap(page, "05-password-filled.png");

    await clickPrimaryButton(page, "password submit");
    await page.waitForTimeout(7000);
    await snap(page, "06-after-password-submit.png");

    console.log("5. Checking what screen appeared after password...");

    if (/captcha|temporarily blocked/i.test(
      await page.locator("body").innerText().catch(() => "")
    )) {
      await snap(page, "error-security-block.png");
      throw new Error("Microsoft showed CAPTCHA or block screen.");
    }

    // Dismiss quick note / stay signed in — loop until all cleared
    let body = await dismissInterstitials(page, "after-password");
    await snap(page, "07-after-interstitials.png");

    if (/Help us protect your account|verify your identity|Email/i.test(body)) {
      console.log("6. Choosing email verification option");
      await clickText(page, "Email", true);
      await page.waitForTimeout(2000);
      await snap(page, "08-email-option-selected.png");

      console.log("7. Typing recovery email");
      const recoveryBox = page
        .locator(
          'input#iProofEmail, input[name="iProofEmail"], input[type="email"], input[type="text"]'
        )
        .first();

      await recoveryBox.waitFor({ state: "visible" });
      await recoveryBox.click();
      await recoveryBox.fill("");
      await recoveryBox.type(recoveryEmail, { delay: 80 });
      await snap(page, "09-recovery-email-filled.png");

      console.log("8. Clicking Send code");
      await snap(page, "10-before-send-code.png");

      const sendCodeBtn = page
        .locator('#iSelectProofAction, input[value="Send code"]')
        .first();

      await sendCodeBtn.waitFor({ state: "visible" });
      await sendCodeBtn.scrollIntoViewIfNeeded();
      await sendCodeBtn.click({ force: true });

      await page.waitForTimeout(7000);
      await snap(page, "11-after-send-code-click.png");

      console.log("9. Waiting for verification code from mail.tm...");
      const verificationCode = await fetchVerificationCode();

      console.log("10. Entering verification code on Microsoft login page...");
      const codeBox = page
        .locator(
          'input#iOttText, input[name="iOttText"], input[placeholder*="code"], input[type="tel"], input[type="number"], input[type="text"]'
        )
        .first();

      await codeBox.waitFor({ state: "visible" });
      await codeBox.click();
      await codeBox.fill("");
      await codeBox.type(verificationCode, { delay: 80 });
      await snap(page, "12-code-entered.png");

      console.log("11. Submitting verification code...");
      await clickPrimaryButton(page, "verify code");
      await page.waitForTimeout(7000);
      await snap(page, "13-after-code-submit.png");

      // Dismiss any interstitials after code submit too
      await dismissInterstitials(page, "after-code");
      console.log("Logged in via verification code flow.");

    } else {
      console.log("Login complete — no verification required.");
    }

    // --- BING SEARCH ---
    const phrase = `${getRandomWord()} ${getRandomWord()}`;
    console.log(`12. Navigating to Bing and searching: "${phrase}"`);
    await page.goto("https://www.bing.com", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    await snap(page, "14-bing-homepage.png");

    const searchBox = page
      .locator('input[name="q"], input#sb_form_q, textarea#sb_form_q')
      .first();

    await searchBox.waitFor({ state: "visible" });
    await searchBox.click();
    await searchBox.fill("");
    await searchBox.type(phrase, { delay: 80 });
    await snap(page, "15-bing-search-typed.png");

    await searchBox.press("Enter");
    await page.waitForTimeout(5000);
    await snap(page, "16-bing-search-results.png");

    console.log("All done!");

  } catch (err) {
    console.error(err);
    await snap(page, "error-current-screen.png");
    throw err;
  } finally {
    await browser.close();
  }
})();
