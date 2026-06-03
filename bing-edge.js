const { chromium } = require("playwright");

const email = process.env.MS_EMAIL;
const password = process.env.MS_PASSWORD;
const recoveryEmail = process.env.MS_RECOVERY_EMAIL;
const githubToken = process.env.TOKEN;

const REPO_OWNER = "monitoroutlookapi";
const REPO_NAME = "shinji_morita";
const WAIT_WORKFLOW_NAME = "wait for me";

if (!email || !password || !recoveryEmail) {
  throw new Error("Missing MS_EMAIL, MS_PASSWORD, or MS_RECOVERY_EMAIL");
}

if (!githubToken) {
  throw new Error("Missing TOKEN");
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

async function triggerWaitWorkflow() {
  console.log(`Triggering workflow: "${WAIT_WORKFLOW_NAME}"`);

  const listRes = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows`,
    {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
      },
    }
  );

  const listData = await listRes.json();
  const workflow = listData.workflows.find(
    (w) => w.name.toLowerCase() === WAIT_WORKFLOW_NAME.toLowerCase()
  );

  if (!workflow) {
    throw new Error(`Could not find workflow named "${WAIT_WORKFLOW_NAME}"`);
  }

  console.log(`Found workflow ID: ${workflow.id}`);

  const beforeTrigger = new Date().toISOString();

  const triggerRes = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${workflow.id}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main" }),
    }
  );

  if (triggerRes.status !== 204) {
    const errText = await triggerRes.text();
    throw new Error(`Failed to trigger workflow: ${triggerRes.status} ${errText}`);
  }

  console.log("Workflow triggered. Waiting for run to appear...");

  let runId = null;
  for (let i = 0; i < 20; i++) {
    await sleep(5000);

    const runsRes = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${workflow.id}/runs?per_page=5`,
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github+json",
        },
      }
    );

    const runsData = await runsRes.json();
    const newRun = runsData.workflow_runs.find(
      (r) => new Date(r.created_at) >= new Date(beforeTrigger)
    );

    if (newRun) {
      runId = newRun.id;
      console.log(`New run found: ID ${runId}`);
      break;
    }
  }

  if (!runId) {
    throw new Error("Could not find the triggered workflow run after polling.");
  }

  return runId;
}

async function waitForWorkflowRun(runId) {
  console.log(`Waiting for workflow run ${runId} to complete...`);

  for (let i = 0; i < 60; i++) {
    await sleep(15000);

    const res = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/runs/${runId}`,
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github+json",
        },
      }
    );

    const data = await res.json();
    console.log(`Run status: ${data.status} / conclusion: ${data.conclusion}`);

    if (data.status === "completed") {
      console.log(`Workflow run completed with conclusion: ${data.conclusion}`);
      return data.conclusion;
    }
  }

  throw new Error("Timed out waiting for workflow run to complete (15 min).");
}

async function readCodeFromRepo() {
  console.log("Reading gmail_email.txt from repo...");

  const res = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/gmail_email.txt`,
    {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
      },
    }
  );

  if (!res.ok) {
    throw new Error(`Could not read gmail_email.txt: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const code = Buffer.from(data.content, "base64").toString("utf-8").trim();
  console.log(`Got verification code: ${code}`);
  return code;
}

// Reads current body, dismisses any interstitial screens, returns final body text
async function dismissInterstitials(page) {
  let body = await page.locator("body").innerText().catch(() => "");

  // "Quick note about your Microsoft account" — click OK
  if (/quick note about your Microsoft account/i.test(body)) {
    console.log("Detected 'Quick note' screen. Clicking OK...");
    await clickText(page, "OK", true);
    await page.waitForTimeout(5000);
    await snap(page, "interstitial-quick-note-ok.png");
    body = await page.locator("body").innerText().catch(() => "");
  }

  // "Stay signed in?" — click Yes
  if (/Stay signed in/i.test(body)) {
    console.log("Detected 'Stay signed in?' screen. Clicking Yes...");
    await clickText(page, "Yes", true);
    await page.waitForTimeout(5000);
    await snap(page, "interstitial-stay-signed-in-yes.png");
    body = await page.locator("body").innerText().catch(() => "");
  }

  return body;
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
    let body = await page.locator("body").innerText().catch(() => "");

    if (/captcha|temporarily blocked/i.test(body)) {
      await snap(page, "error-security-block.png");
      throw new Error("Microsoft showed CAPTCHA or block screen.");
    }

    // Dismiss quick note and/or stay signed in if they appear right after password
    body = await dismissInterstitials(page);

    // Check if we are now past login (no more verification needed)
    if (!/Help us protect your account|verify your identity|Email/i.test(body)) {
      console.log("Login complete — no verification required.");
    } else {
      // Verification required flow
      console.log("6. Choosing email verification option");
      await clickText(page, "Email", true);
      await page.waitForTimeout(2000);
      await snap(page, "07-email-option-selected.png");

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
      await snap(page, "08-recovery-email-filled.png");

      console.log("8. Clicking Send code");
      await snap(page, "09-before-send-code.png");

      const sendCodeBtn = page
        .locator('#iSelectProofAction, input[value="Send code"]')
        .first();

      await sendCodeBtn.waitFor({ state: "visible" });
      await sendCodeBtn.scrollIntoViewIfNeeded();
      await sendCodeBtn.click({ force: true });

      await page.waitForTimeout(7000);
      await snap(page, "10-after-send-code-click.png");

      console.log("9. Triggering 'wait for me' workflow...");
      const runId = await triggerWaitWorkflow();

      console.log("10. Waiting for 'wait for me' workflow to finish...");
      const conclusion = await waitForWorkflowRun(runId);

      if (conclusion !== "success") {
        throw new Error(`'wait for me' workflow ended with: ${conclusion}`);
      }

      console.log("11. Reading verification code from gmail_email.txt...");
      const verificationCode = await readCodeFromRepo();

      console.log("12. Entering verification code on Microsoft login page...");
      const codeBox = page
        .locator(
          'input#iOttText, input[name="iOttText"], input[placeholder*="code"], input[type="tel"], input[type="number"], input[type="text"]'
        )
        .first();

      await codeBox.waitFor({ state: "visible" });
      await codeBox.click();
      await codeBox.fill("");
      await codeBox.type(verificationCode, { delay: 80 });
      await snap(page, "11-code-entered.png");

      console.log("13. Submitting verification code...");
      await clickPrimaryButton(page, "verify code");
      await page.waitForTimeout(7000);
      await snap(page, "12-after-code-submit.png");

      // Dismiss any interstitials after code submit too
      await dismissInterstitials(page);

      console.log("Logged in via verification code flow.");
    }

    // --- BING SEARCH ---
    console.log("14. Getting random words...");
    const word1Res = await fetch("https://random-word-api.herokuapp.com/word");
    const word2Res = await fetch("https://random-word-api.herokuapp.com/word");
    const [word1] = await word1Res.json();
    const [word2] = await word2Res.json();
    const phrase = `${word1} ${word2}`;

    console.log(`15. Navigating to Bing and searching: "${phrase}"`);
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
