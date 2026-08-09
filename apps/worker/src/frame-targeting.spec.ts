import { dispatchCommand } from './execute-browser-handler';

/**
 * Bank portals embed whole applications in iframes — ICICI serves statements
 * from Finacle that way. The recorder always captured those clicks (its init
 * script runs in every frame), but every command ran against the top-level
 * page, so a control the human successfully clicked compiled into a step
 * nothing could execute. One run read that as the portal being "fundamentally
 * frame-gated" and shipped a skill that screenshots the page instead of using
 * it.
 */

function makeFrame(url: string, name = '') {
  const clicked: string[] = [];
  const frame: any = {
    url: () => url,
    name: () => name,
    _clicked: clicked,
    locator: (sel: string) => ({
      filter: () => ({ count: async () => 1, first: () => frame._el(sel) }),
      first: () => frame._el(sel),
      fill: async (t: string) => clicked.push(`fill:${sel}=${t}`),
      waitFor: async () => clicked.push(`wait:${sel}`),
    }),
    _el: (sel: string) => ({
      click: async () => clicked.push(`click:${sel}`),
      scrollIntoViewIfNeeded: async () => undefined,
      boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
    }),
    evaluate: async () => ({ elements: [{ text: `inside ${url}` }] }),
  };
  return frame;
}

function makePage(frames: any[]) {
  const main = makeFrame('https://bank.test/overview');
  const page: any = {
    ...main,
    mainFrame: () => main,
    frames: () => [main, ...frames],
  };
  return page;
}

describe('addressing a control inside an iframe', () => {
  it('clicks in the frame whose url is given, not the top-level page', async () => {
    const finacle = makeFrame('https://finacle.bank.test/statements?tok=abc');
    const page = makePage([finacle]);

    await dispatchCommand(page, 'click_element', {
      selector: '#PDF_Download',
      frame_url: 'https://finacle.bank.test/statements?tok=abc',
    }, 1000);

    expect(finacle._clicked).toContain('click:#PDF_Download');
    expect(page._clicked).not.toContain('click:#PDF_Download');
  });

  it('matches a frame whose session token has changed since the recording', async () => {
    // The recorded url carries a one-shot token; today's frame carries another.
    const finacle = makeFrame('https://finacle.bank.test/statements?tok=NEW');
    const page = makePage([finacle]);

    await dispatchCommand(page, 'click_element', {
      selector: '#PDF_Download',
      frame_url: 'https://finacle.bank.test/statements?tok=RECORDED',
    }, 1000);

    expect(finacle._clicked).toContain('click:#PDF_Download');
  });

  it('prefers the frame name, which survives url churn entirely', async () => {
    const a = makeFrame('https://finacle.bank.test/x?tok=1', 'finacleFrame');
    const b = makeFrame('https://ads.example.com/pixel');
    const page = makePage([b, a]);

    await dispatchCommand(page, 'type_text', {
      selector: '#period',
      text: 'July',
      frame_name: 'finacleFrame',
    }, 1000);

    expect(a._clicked).toContain('fill:#period=July');
    expect(b._clicked).toEqual([]);
  });

  it('says which frames exist when the named one is absent', async () => {
    const page = makePage([makeFrame('https://finacle.bank.test/statements')]);

    await expect(
      dispatchCommand(page, 'click_element', { selector: '#x', frame_url: 'https://gone.test/' }, 1000),
    ).rejects.toThrow(/No frame matched.*finacle\.bank\.test/s);
  });

  it('still targets the page when no frame is named', async () => {
    const finacle = makeFrame('https://finacle.bank.test/statements');
    const page = makePage([finacle]);

    await dispatchCommand(page, 'click_element', { selector: '#nav' }, 1000);

    expect(page._clicked).toContain('click:#nav');
    expect(finacle._clicked).toEqual([]);
  });
});

describe('get_page_summary and frames', () => {
  it('names the frames it did not read, so an absence is not read as a dead end', async () => {
    const page = makePage([makeFrame('https://finacle.bank.test/statements', 'finacleFrame')]);

    const summary: any = await dispatchCommand(page, 'get_page_summary', {}, 1000);

    expect(summary.frames).toEqual([
      { url: 'https://finacle.bank.test/statements', name: 'finacleFrame' },
    ]);
    expect(summary.frames_note).toMatch(/NOT included/);
  });

  it('reads inside the frame when one is named', async () => {
    const page = makePage([makeFrame('https://finacle.bank.test/statements')]);

    const summary: any = await dispatchCommand(
      page, 'get_page_summary', { frame_url: 'https://finacle.bank.test/statements' }, 1000,
    );

    expect(summary.elements[0].text).toBe('inside https://finacle.bank.test/statements');
    // No "you are missing something" note — we just read the thing.
    expect(summary.frames_note).toBeUndefined();
  });

  it('says nothing about frames on a page that has none', async () => {
    const page = makePage([]);
    const summary: any = await dispatchCommand(page, 'get_page_summary', {}, 1000);
    expect(summary.frames).toBeUndefined();
    expect(summary.frames_note).toBeUndefined();
  });
});
