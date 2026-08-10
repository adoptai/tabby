import { deriveOutcomes, DOWNLOAD_WINDOW_MS } from './recording-outcomes';

/**
 * A download is attributed to the last interaction before it, not to whatever
 * lands inside the 2.5s request window.
 *
 * At the request window's size the compiler emitted NO download operation for
 * any bank recording: a statement PDF is generated server-side and arrives five
 * to thirty seconds after the click, so no interaction ever carried
 * outcome.download, `_terminal_kind` derived no terminal operation, and an ICICI
 * capture whose whole point was downloading a statement compiled to
 * read_overview + read_credit_card.
 */

const T0 = Date.parse('2026-08-09T10:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

const click = (ms: number, text: string) =>
  ({ event_type: 'click', event_time: at(ms), text_content: text }) as any;

function run(events: any[], downloadsAtMs: number[]) {
  deriveOutcomes(
    events,
    [],
    downloadsAtMs.map((ms) => ({ timestamp: at(ms) })) as any,
    { log: { entries: [] } } as any,
  );
  return events;
}

describe('attributing a download to the click that caused it', () => {
  it('credits a statement PDF that takes 12 seconds to arrive', async () => {
    const events = [click(0, 'Download Statement')];
    run(events, [12_000]);
    expect(events[0].outcome.download).toBe(true);
  });

  it('still credits it when the human clicked elsewhere while waiting', () => {
    // The exact case the old truncation lost: the window ended at the next
    // interaction, so a file arriving after it belonged to nobody.
    const events = [click(0, 'Download Statement'), click(3_000, 'Close')];
    run(events, [15_000]);
    expect(events[0].outcome.download).toBe(true);
    expect(events[1].outcome.download).toBe(false);
  });

  it('gives the file exactly one owner, and prefers the labelled control', () => {
    // Export opens a dialog that Confirm completes. We credit Export, because
    // its label is what a user would ask for and what the operation is named
    // after. KNOWN LIMIT: a terminal operation is one interaction, so a
    // two-click confirm flow compiles to the Export click alone and may need
    // the dialog step added. That is a smaller gap than emitting nothing.
    const events = [click(0, 'Export'), click(1_000, 'Confirm')];
    run(events, [9_000]);
    const owners = events.filter((e) => e.outcome.download);
    expect(owners).toHaveLength(1);
    expect(owners[0].text_content).toBe('Export');
  });

  it('falls back to the most recent click when no label says download', () => {
    const events = [click(0, 'Accounts'), click(1_000, 'Continue')];
    run(events, [8_000]);
    const owners = events.filter((e) => e.outcome.download);
    expect(owners).toHaveLength(1);
    expect(owners[0].text_content).toBe('Continue');
  });

  it('does not credit a click that happened after the download', () => {
    const events = [click(20_000, 'Something else')];
    run(events, [5_000]);
    expect(events[0].outcome.download).toBe(false);
  });

  it('stops attributing across a long idle', () => {
    // Beyond the budget the last click is no longer a plausible cause.
    const events = [click(0, 'Download')];
    run(events, [DOWNLOAD_WINDOW_MS + 30_000]);
    expect(events[0].outcome.download).toBe(false);
  });

  it('leaves request attribution on the tight window', () => {
    // Downloads got a longer budget; traffic must not have, or every click on a
    // bank portal would claim every XHR.
    const events = [click(0, 'Filter')];
    deriveOutcomes(
      events,
      [],
      [] as any,
      { log: { entries: [{ startedDateTime: at(60_000), time: 10 }] } } as any,
    );
    expect(events[0].outcome.request_count).toBe(0);
  });
});
