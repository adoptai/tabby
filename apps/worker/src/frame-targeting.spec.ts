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
    // Mirrors the parts of a Playwright locator these commands touch — count()
    // included, since resolution now asks whether anything matched before
    // falling back to the recording's other candidates.
    locator: (sel: string) => ({
      count: async () => 1,
      filter: () => ({ count: async () => 1, first: () => frame._el(sel) }),
      first: () => frame._el(sel),
      fill: async (t: string) => clicked.push(`fill:${sel}=${t}`),
      waitFor: async () => clicked.push(`wait:${sel}`),
    }),
    getByText: (t: string) => ({
      count: async () => 1,
      filter: () => ({ count: async () => 1, first: () => frame._el(`text=${t}`) }),
      first: () => frame._el(`text=${t}`),
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

/**
 * When the compiled selector dies, the recording's other candidates are tried.
 *
 * ICICI's nav is icon divs, so the winning candidate is a positional css path,
 * and one shifted node kills every nav step — while a hand-written skill
 * clicking the same controls by TEXT worked on the same portal. The text was
 * recorded alongside the path and thrown away at compile time.
 */
function pageWithOnly(present: string) {
  const clicked: string[] = [];
  // A real locator.first() answers count(), which is how the zero-match
  // fast-fail decides a control simply is not there.
  const mk = (sel: string) => ({
    count: async () => (sel === present ? 1 : 0),
    click: async () => clicked.push(`click:${sel}`),
    scrollIntoViewIfNeeded: async () => undefined,
    boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
  });
  const loc = (sel: string, n: number) => ({
    count: async () => n,
    filter: () => ({ count: async () => n, first: () => mk(sel) }),
    first: () => mk(sel),
  });
  const page: any = {
    _clicked: clicked,
    mainFrame: () => page,
    frames: () => [page],
    locator: (sel: string) => loc(sel, sel === present ? 1 : 0),
    getByText: (t: string) => loc(`text=${t}`, `text=${t}` === present ? 1 : 0),
  };
  return page;
}

describe('falling back to the recording’s other candidates', () => {
  it('clicks by text when the compiled css path no longer matches', async () => {
    const page = pageWithOnly('text=Cards');

    const res: any = await dispatchCommand(
      page,
      'click_element',
      {
        selector: '#scroll-container > div > div:nth-of-type(5)',
        fallbacks: [{ selector: '#gone' }, { text: 'Cards' }],
      },
      1000,
    );

    expect(page._clicked).toContain('click:text=Cards');
    // And it says which one worked, so a repair pass can promote it.
    expect(res.used_fallback).toBe('text=Cards');
  });

  it('uses the compiled selector when it still matches, and reports no fallback', async () => {
    const page = pageWithOnly('#ok');
    const res: any = await dispatchCommand(
      page,
      'click_element',
      { selector: '#ok', fallbacks: [{ text: 'Cards' }] },
      1000,
    );
    expect(page._clicked).toContain('click:#ok');
    expect(res.used_fallback).toBeUndefined();
  });

  it('still refuses when neither the selector nor any fallback matches', async () => {
    const page = pageWithOnly('#something-else');
    await expect(
      dispatchCommand(page, 'click_element', { selector: '#a', fallbacks: [{ text: 'B' }] }, 1000),
    ).rejects.toThrow(/nothing on the page matches/);
  });
});

/**
 * A dead end lists what IS on the page.
 *
 * "Nothing matches, read the page" sends the caller back to guessing: an ICICI
 * replay answered it with screenshots and probing until a human supplied the
 * answer from a skill they had written by hand. A customer building their first
 * skill has no such reference, so the failure has to carry the options.
 */
describe('when nothing matches, say what is there', () => {
  function pageWithControls(controls: Array<{ text: string; selector: string }>) {
    const loc = (n: number) => ({
      count: async () => n,
      filter: () => ({ count: async () => n, first: () => ({ count: async () => n }) }),
      first: () => ({ count: async () => n }),
    });
    const page: any = {
      mainFrame: () => page,
      frames: () => [page],
      locator: () => loc(0),
      getByText: () => loc(0),
      evaluate: async () => ({ elements: controls }),
    };
    return page;
  }

  it('lists real controls, closest to the target first', async () => {
    const page = pageWithControls([
      { text: 'Accounts', selector: '#accounts' },
      { text: 'Credit Cards', selector: '#credit-cards' },
      { text: 'Offers', selector: '#offers' },
    ]);

    await expect(
      dispatchCommand(page, 'click_element', { selector: '#cardStatementTracker > div' }, 1000),
    ).rejects.toThrow(/Credit Cards.*#credit-cards/s);
  });

  it('says how many recorded alternatives were also tried', async () => {
    const page = pageWithControls([{ text: 'Cards', selector: '#cards' }]);

    await expect(
      dispatchCommand(
        page,
        'click_element',
        { selector: '#gone', fallbacks: [{ text: 'Nope' }, { selector: '#also-gone' }] },
        1000,
      ),
    ).rejects.toThrow(/2 recorded alternative\(s\)/);
  });

  it('is honest when the page offers nothing to suggest', async () => {
    const page = pageWithControls([]);
    await expect(
      dispatchCommand(page, 'click_element', { selector: '#x' }, 1000),
    ).rejects.toThrow(/no addressable controls to suggest/);
  });
});


describe('hover opens what the next click needs', () => {
  it('hovers the named control, including inside a frame', async () => {
    const hovered: string[] = [];
    const mk = (sel: string) => ({
      count: async () => 1,
      hover: async () => hovered.push(`hover:${sel}`),
      click: async () => undefined,
      scrollIntoViewIfNeeded: async () => undefined,
      boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
    });
    const loc = (sel: string) => ({
      count: async () => 1,
      filter: () => ({ count: async () => 1, first: () => mk(sel) }),
      first: () => mk(sel),
    });
    const frame: any = { url: () => 'https://finacle.test/x', name: () => '', locator: loc, getByText: loc };
    const page: any = {
      mainFrame: () => page,
      frames: () => [page, frame],
      locator: loc,
      getByText: loc,
    };

    await dispatchCommand(page, 'hover', { selector: '#nav-cards' }, 1000);
    expect(hovered).toContain('hover:#nav-cards');

    await dispatchCommand(
      page, 'hover', { selector: '#menu', frame_url: 'https://finacle.test/x' }, 1000,
    );
    expect(hovered).toContain('hover:#menu');
  });

  it('refuses to hover a control that is not there, listing what is', async () => {
    const page: any = {
      mainFrame: () => page,
      frames: () => [page],
      locator: () => ({ count: async () => 0, filter: () => ({ count: async () => 0, first: () => ({ count: async () => 0 }) }), first: () => ({ count: async () => 0 }) }),
      getByText: () => ({ count: async () => 0, filter: () => ({ count: async () => 0, first: () => ({}) }), first: () => ({}) }),
      evaluate: async () => ({ elements: [{ text: 'Cards', selector: '#cards' }] }),
    };
    await expect(
      dispatchCommand(page, 'hover', { selector: '#gone' }, 1000),
    ).rejects.toThrow(/nothing on the page matches.*Cards/s);
  });
});
