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

const FRAME_HTML = `<!doctype html><html><body>
  <button id="PDF_Download">Download Statement</button>
  <script>
    document.getElementById('PDF_Download').addEventListener('click', function () {
      var a = document.createElement('a');
      a.href = '/statement.pdf';                          // server delays it
      a.download = 'statement.pdf';
      document.body.appendChild(a);
      a.click();
    });
  </script>
</body></html>`;

function startFixture(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
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
    res.end(APP_HTML);
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
    await dispatchCommand(page, 'wait_for_selector', { selector: '#PDF_Download', frame_url: frameUrl }, 15_000);
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
