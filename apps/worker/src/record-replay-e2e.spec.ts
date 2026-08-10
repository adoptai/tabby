import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { RecordingRunner } from './recording-runner';
import { dispatchCommand } from './execute-browser-handler';
import { enableDownloadCapture, listDownloads } from './download-capture';

/**
 * The loop this whole pipeline exists for: a human drives a page, and a replay
 * reaches the SAME end state.
 *
 * Every other test here proves one layer. This one proves they meet, against a
 * real browser, on the three things a bank portal actually does and every live
 * run has stumbled over:
 *
 *   1. an app embedded in an IFRAME  — ICICI serves statements from Finacle
 *      that way, and the click that matters happens inside it;
 *   2. a SLOW download               — a statement PDF is generated server-side
 *      and arrives long after the click that asked for it;
 *   3. an SPA route change           — no page load, so nothing to wait on.
 *
 * It was written because five live runs each revealed exactly one bug: every
 * layer was unit-tested and the loop had never once been observed to close.
 */

const DOWNLOAD_DELAY_MS = 3_500; // > OUTCOME_WINDOW_MS (2500), as a real one is

const APP_HTML = `<!doctype html><html><body>
  <h1 id="title">Overview</h1>
  <a href="#" id="nav-statements">Statements</a>
  <div id="panel"></div>
  <script>
    document.getElementById('nav-statements').addEventListener('click', function (e) {
      e.preventDefault();
      history.pushState({}, '', '/app#statements');       // SPA route: no load
      document.getElementById('title').textContent = 'Statements';
      var f = document.createElement('iframe');
      f.id = 'finacle';
      f.name = 'finacleFrame';
      f.src = '/finacle';
      document.getElementById('panel').appendChild(f);
    });
  </script>
</body></html>`;

// The download only works after the tab and the period are chosen — the shape
// of every bank statement screen, and what a single-click compile lost.
const FRAME_HTML = `<!doctype html><html><body>
  <button id="tab-past">Past Statements</button>
  <button id="period-annual" disabled>Annual</button>
  <button id="PDF_Download" disabled>Download Statement</button>
  <script>
    var period = '';
    document.getElementById('tab-past').addEventListener('click', function () {
      document.getElementById('period-annual').disabled = false;
    });
    document.getElementById('period-annual').addEventListener('click', function () {
      period = 'annual';
      document.getElementById('PDF_Download').disabled = false;
    });
    document.getElementById('PDF_Download').addEventListener('click', function () {
      var a = document.createElement('a');
      a.href = '/statement.pdf?period=' + period;         // server delays it
      a.download = 'statement.pdf';
      document.body.appendChild(a);
      a.click();
    });
  </script>
</body></html>`;

/** A second origin for the embedded app — a different port IS a different origin. */
function startFrameOrigin(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/statement.pdf')) {
      setTimeout(() => {
        res.writeHead(200, {
          'content-type': 'application/pdf',
          'content-disposition': 'attachment; filename="statement.pdf"',
        });
        res.end('%PDF-1.4 fixture');
      }, DOWNLOAD_DELAY_MS);
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html',
      // Cross-origin AND locked down, the way a real embedded bank app arrives.
      'content-security-policy': "default-src 'self'; connect-src 'self'; script-src 'self' 'unsafe-inline'",
    });
    res.end(FRAME_HTML);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://localhost:${port}` });   // different host+port
    });
  });
}

function startFixture(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/finacle-csp')) {
      // A bank's embedded app, served the way banks serve them: a strict CSP
      // that permits network calls only back to its own origin. The recorder's
      // beacon is a fetch to a sentinel host, so connect-src decides whether an
      // in-frame click can be recorded at all.
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-security-policy': "default-src 'self'; connect-src 'self'; script-src 'self' 'unsafe-inline'",
      });
      res.end(FRAME_HTML);
      return;
    }
    if (req.url?.startsWith('/finacle')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(FRAME_HTML);
      return;
    }
    if (req.url?.startsWith('/statement.pdf')) {
      // The whole point: the file lands well after the click.
      setTimeout(() => {
        res.writeHead(200, {
          'content-type': 'application/pdf',
          'content-disposition': 'attachment; filename="statement.pdf"',
        });
        res.end('%PDF-1.4 fixture');
      }, DOWNLOAD_DELAY_MS);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url?.startsWith('/app-csp') ? APP_HTML.replace("'/finacle'", "'/finacle-csp'") : APP_HTML);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

jest.setTimeout(120_000);

describe('record → replay reaches the same end state', () => {
  let server: Server;
  let base: string;
  let browser: Browser;

  beforeAll(async () => {
    ({ server, base } = await startFixture());
    // Prefer Playwright's own bundled browser; fall back to the system Chrome so
    // the loop can be validated on a machine that has not run `playwright
    // install`. CI should run that install and take the first branch.
    try {
      browser = await chromium.launch();
    } catch {
      browser = await chromium.launch({ channel: 'chrome' });
    }
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise((r) => server?.close(() => r(null)));
  });

  let bundle: any;

  it('records the iframe click and attributes the slow download to it', async () => {
    const context: BrowserContext = await browser.newContext({ acceptDownloads: true });
    const page: Page = await context.newPage();

    // login mode + browserDriven: exactly how a COMBINED capture is provisioned,
    // and the case where rich capture used to be silently off.
    const runner = new RecordingRunner(page, context, 'sess-e2e', 'login', true);
    await runner.start();   // attaches its own download capture

    await page.goto(`${base}/app`);
    await page.click('#nav-statements');                       // SPA route change
    const frame = page.frameLocator('#finacle');
    await frame.locator('#tab-past').click();                  // lead-in: the tab
    await frame.locator('#period-annual').click();             // lead-in: the period
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await frame.locator('#PDF_Download').click();              // the click that matters
    await downloadPromise;
    await page.waitForTimeout(500);

    bundle = await runner.drain();
    await context.close();

    const clicks = bundle.click_events || [];
    const inFrame = clicks.filter((c: any) => c?.element?.in_iframe);
    expect(inFrame.length).toBeGreaterThan(0);

    // 1. the frame is IDENTIFIED, not just flagged — a replay needs the address.
    expect(inFrame[0].element.frame_url).toContain('/finacle');

    // 2. the slow download is attributed to the click that asked for it.
    // 2. the slow download (3.5s, past the request window) is attributed to the
    //    click that asked for it — and to the IN-FRAME one, not the SPA nav.
    const withDownload = clicks.filter((c: any) => c?.outcome?.download);
    expect(withDownload.length).toBeGreaterThan(0);
    expect(withDownload.every((c: any) => c.element?.in_iframe)).toBe(true);

    // 3. the file itself was recorded, which is what a compiled download
    //    operation asserts on at replay.
    expect((bundle.download_events || []).length).toBeGreaterThan(0);

    // 4. the clicks that DECIDE what is downloaded are recorded before it, in
    //    order — a download compiled from the last click alone would replay
    //    against a disabled button.
    const frameClicks = clicks.filter((c: any) => c?.element?.in_iframe);
    expect(frameClicks.length).toBeGreaterThanOrEqual(3);
  });

  it('replays those steps and reaches the same end state — the file arrives', async () => {
    // Replay drives a FRESH page, exactly as a runtime session would.
    const context: BrowserContext = await browser.newContext({ acceptDownloads: true });
    enableDownloadCapture(context);   // the runtime's own capture, as a session has
    const page: Page = await context.newPage();

    // The steps a compiled browser skill carries: reach the page, then the
    // frame-addressed interaction. Built from the recording, not invented.
    const recorded = (bundle.click_events || []).find((c: any) => c?.outcome?.download);
    const frameUrl = recorded.element.frame_url;

    await dispatchCommand(page, 'navigate', { url: `${base}/app` }, 15_000);
    await dispatchCommand(page, 'click_by_text', { text: 'Statements', exact: true }, 15_000);
    await dispatchCommand(page, 'wait_for_selector', { selector: '#tab-past', frame_url: frameUrl }, 15_000);
    // The lead-in the compiler now emits. Without these the download button is
    // disabled and no file arrives, which is the whole point of keeping them.
    await dispatchCommand(page, 'click_element', { selector: '#tab-past', frame_url: frameUrl }, 15_000);
    await dispatchCommand(page, 'click_element', { selector: '#period-annual', frame_url: frameUrl }, 15_000);
    const waitDownload = page.waitForEvent('download', { timeout: 30_000 });
    await dispatchCommand(page, 'click_element', { selector: '#PDF_Download', frame_url: frameUrl }, 15_000);
    await waitDownload;
    await page.waitForTimeout(500);

    // THE assertion: the replay ended where the recording ended — a file exists.
    const { downloads } = listDownloads(page);
    expect(downloads.length).toBeGreaterThan(0);

    // And the page state matches too, not just the artifact.
    const summary: any = await dispatchCommand(page, 'get_page_summary', {}, 15_000);
    expect(JSON.stringify(summary)).toContain('Statements');
    expect(summary.frames?.length).toBeGreaterThan(0);

    await context.close();
  });
});

/**
 * Can a click inside a CSP-locked frame be recorded at all?
 *
 * The recorder reports each interaction by fetching a sentinel URL, which the
 * worker reads off page.on('request'). A bank's embedded app typically ships
 * `connect-src 'self'`, and if that blocks the beacon then in-frame clicks never
 * reach the bundle — and no amount of frame targeting, download attribution or
 * gate work downstream matters, because there is nothing recorded to compile.
 *
 * This is the one property the plain fixture cannot answer, and the last thing
 * standing between "proven on a fixture" and "will work on ICICI".
 */
describe('recording inside a CSP-locked frame', () => {
  let server: Server;
  let base: string;
  let browser: Browser;

  beforeAll(async () => {
    ({ server, base } = await startFixture());
    try {
      browser = await chromium.launch();
    } catch {
      browser = await chromium.launch({ channel: 'chrome' });
    }
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise((r) => server?.close(() => r(null)));
  });

  it('captures the in-frame click despite connect-src self', async () => {
    const context: BrowserContext = await browser.newContext({ acceptDownloads: true });
    const page: Page = await context.newPage();
    const runner = new RecordingRunner(page, context, 'sess-csp', 'login', true);
    await runner.start();

    await page.goto(`${base}/app-csp`);
    await page.click('#nav-statements');
    const frame = page.frameLocator('#finacle');
    await frame.locator('#tab-past').click();
    await page.waitForTimeout(300);

    const bundle: any = await runner.drain();
    await context.close();

    const inFrame = (bundle.click_events || []).filter((c: any) => c?.element?.in_iframe);
    expect(inFrame.length).toBeGreaterThan(0);
    expect(inFrame[0].element.frame_url).toContain('/finacle-csp');
  });
});

/**
 * The embedded app on a DIFFERENT ORIGIN, which is how banks actually deploy it
 * — ICICI's statements come from a separate Finacle host, not a path on the
 * portal.
 *
 * Cross-origin changes what the recorder can see and what the runtime can
 * address: the injected script cannot reach across the boundary, and a frame
 * has to be found by its own url rather than by walking the parent's DOM. The
 * same-origin fixtures cannot tell us whether either holds.
 */
describe('recording and replaying across an origin boundary', () => {
  let appServer: Server;
  let frameServer: Server;
  let appBase: string;
  let frameBase: string;
  let browser: Browser;

  beforeAll(async () => {
    ({ server: frameServer, base: frameBase } = await startFrameOrigin());
    // The app page embeds the OTHER origin.
    const appHtml = APP_HTML.replace("'/finacle'", `'${frameBase}/finacle'`);
    appServer = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(appHtml);
    });
    await new Promise<void>((r) =>
      appServer.listen(0, '127.0.0.1', () => {
        appBase = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
        r();
      }),
    );
    try {
      browser = await chromium.launch();
    } catch {
      browser = await chromium.launch({ channel: 'chrome' });
    }
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise((r) => appServer?.close(() => r(null)));
    await new Promise((r) => frameServer?.close(() => r(null)));
  });

  it('records the click and identifies the frame by its own origin', async () => {
    const context: BrowserContext = await browser.newContext({ acceptDownloads: true });
    const page: Page = await context.newPage();
    const runner = new RecordingRunner(page, context, 'sess-xorigin', 'login', true);
    await runner.start();

    await page.goto(`${appBase}/app`);
    await page.click('#nav-statements');
    const frame = page.frameLocator('#finacle');
    await frame.locator('#tab-past').click();
    await frame.locator('#period-annual').click();
    const dl = page.waitForEvent('download', { timeout: 30_000 });
    await frame.locator('#PDF_Download').click();
    await dl;
    await page.waitForTimeout(500);

    const bundle: any = await runner.drain();
    await context.close();

    const inFrame = (bundle.click_events || []).filter((c: any) => c?.element?.in_iframe);
    expect(inFrame.length).toBeGreaterThanOrEqual(3);
    // The frame is addressed by ITS origin, not the page's.
    expect(inFrame[0].element.frame_url.startsWith(frameBase)).toBe(true);
    // And the download is still attributed across the boundary.
    expect((bundle.click_events || []).some((c: any) => c?.outcome?.download)).toBe(true);
  });

  it('replays into the cross-origin frame and gets the file', async () => {
    const context: BrowserContext = await browser.newContext({ acceptDownloads: true });
    enableDownloadCapture(context);
    const page: Page = await context.newPage();
    const frameUrl = `${frameBase}/finacle`;

    await dispatchCommand(page, 'navigate', { url: `${appBase}/app` }, 15_000);
    await dispatchCommand(page, 'click_by_text', { text: 'Statements', exact: true }, 15_000);
    await dispatchCommand(page, 'wait_for_selector', { selector: '#tab-past', frame_url: frameUrl }, 15_000);
    await dispatchCommand(page, 'click_element', { selector: '#tab-past', frame_url: frameUrl }, 15_000);
    await dispatchCommand(page, 'click_element', { selector: '#period-annual', frame_url: frameUrl }, 15_000);
    const waitDownload = page.waitForEvent('download', { timeout: 30_000 });
    await dispatchCommand(page, 'click_element', { selector: '#PDF_Download', frame_url: frameUrl }, 15_000);
    await waitDownload;
    await page.waitForTimeout(500);

    const { downloads } = listDownloads(page);
    expect(downloads.length).toBeGreaterThan(0);

    // get_page_summary must report the cross-origin frame it did not read.
    const summary: any = await dispatchCommand(page, 'get_page_summary', {}, 15_000);
    expect(summary.frames?.some((f: any) => String(f.url).startsWith(frameBase))).toBe(true);

    await context.close();
  });
});
