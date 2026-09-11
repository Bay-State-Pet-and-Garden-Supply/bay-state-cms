// @vitest-environment jsdom
/**
 * Ticket #124 — mounted GapCorrectionPanel coverage (Vitest jsdom).
 *
 * Request-for-help rendering from persisted gap facts, correction submit
 * with Idempotency-Key, accepted state (gap clears only on validation —
 * submit alone is "recorded"), error path preserving product context, and
 * keyboard-operable form controls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { GapCorrectionPanel } from '../../client/components/onboarding/GapCorrectionPanel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const GAP = {
  id: 'pgap_1',
  itemId: 'item-1',
  batchId: 'batch-1',
  missingFields: ['description'],
  reason: 'No description from collected sources.',
  evidenceHash: 'a'.repeat(64),
  status: 'open',
  correctionRevision: 0,
  correctionEnvelope: null,
  updatedAt: '2026-09-11T00:00:00.000Z',
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/correct') && init?.method === 'POST') {
      const headers = new Headers(init.headers);
      if (!headers.get('Idempotency-Key')) return jsonResponse({ error: 'idempotency_key_required' }, 400);
      return jsonResponse({
        gap: { ...GAP, correctionRevision: 1 },
        envelope: { revision: 1, status: 'recorded' },
        receiptId: 'receipt-1',
        replay: false,
      });
    }
    return jsonResponse({ gap: GAP });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  act(() => root!.unmount());
  container!.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

async function renderPanel() {
  await act(async () => {
    root!.render(<GapCorrectionPanel itemId="item-1" itemName="Acana Food" />);
  });
  // Deterministic settle (T-8): loading leaves only when the form, the
  // clear state, or an error renders — no fixed sleeps.
  await vi.waitFor(() => {
    const loading = container!.textContent?.includes('Checking listing readiness') ?? false;
    const settled = container!.querySelector(
      'form, [data-testid="gap-panel-clear-item-1"], [data-testid="gap-panel-error-item-1"]',
    );
    expect(!loading && settled !== null).toBe(true);
  });
  await act(async () => {});
}

async function waitForSettled() {
  await act(async () => {});
}

function fillDescription(text: string) {
  const textarea = container!.querySelector('#gap-item-1-description') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(textarea, text);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('GapCorrectionPanel', () => {
  it('renders the persisted request for help with labelled inputs per missing field', async () => {
    await renderPanel();
    expect(container!.textContent).toMatch(/Listing help needed/);
    expect(container!.textContent).toMatch(/Acana Food/);
    expect(container!.textContent).toMatch(/No description from collected sources/);
    expect(container!.querySelector('label[for="gap-item-1-description"]')?.textContent).toMatch(/Description/);
    expect(container!.querySelector('form[aria-label="Correct listing information for Acana Food"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="gap-panel-submit-item-1"]')).not.toBeNull();
    // Strategy vs listing approval stay distinct in copy.
    expect(container!.textContent).toMatch(/ordinary Review listings approval/);
  });

  it('submit sends values with an Idempotency-Key and shows accepted (not complete)', async () => {
    await renderPanel();
    const textarea = container!.querySelector('#gap-item-1-description') as HTMLTextAreaElement;
    await act(async () => {
      textarea.value = 'Operator-supplied description';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // React controlled input: set via native setter for the change to register.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, 'Operator-supplied description');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (container!.querySelector('[data-testid="gap-panel-submit-item-1"]') as HTMLButtonElement).click();
    });
    await vi.waitFor(() => {
      expect(container!.querySelector('[data-testid="gap-panel-accepted-item-1"]')).not.toBeNull();
    });
    await waitForSettled();
    const post = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/correct'));
    expect(post).toBeTruthy();
    expect(new Headers((post![1] as RequestInit).headers).get('Idempotency-Key')).toBeTruthy();
    expect(container!.querySelector('[data-testid="gap-panel-accepted-item-1"]')).not.toBeNull();
    // Accepted ≠ complete: copy says the gap clears only on validation.
    expect(container!.textContent).toMatch(/clears only when validation succeeds/);
  });

  it('failed submit keeps product context and shows the error', async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ gap: GAP }));
    fetchMock.mockImplementationOnce(async () => jsonResponse({ error: 'correction_incomplete', code: 'correction_incomplete' }, 422));
    await renderPanel();
    await act(async () => {
      (container!.querySelector('[data-testid="gap-panel-submit-item-1"]') as HTMLButtonElement).click();
    });
    await vi.waitFor(() => {
      expect(container!.querySelector('[data-testid="gap-panel-error-item-1"]')).not.toBeNull();
    });
    await waitForSettled();
    expect(container!.querySelector('[data-testid="gap-panel-error-item-1"]')).not.toBeNull();
    // Product context preserved: the form is still there with its labels.
    expect(container!.querySelector('form[aria-label="Correct listing information for Acana Food"]')).not.toBeNull();
    expect(container!.querySelector('#gap-item-1-description')).not.toBeNull();
  });

  it('no open gap renders the clear state, never a form', async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ gap: null }));
    await renderPanel();
    expect(container!.querySelector('[data-testid="gap-panel-clear-item-1"]')).not.toBeNull();
    expect(container!.querySelector('form')).toBeNull();
  });

  it('Enter on the form submits via the same handler as the button (T-8)', async () => {
    await renderPanel();
    await act(async () => {
      fillDescription('Operator-supplied description');
    });
    await act(async () => {
      const form = container!.querySelector('form[aria-label="Correct listing information for Acana Food"]') as HTMLFormElement;
      form.requestSubmit();
    });
    await vi.waitFor(() => {
      expect(container!.querySelector('[data-testid="gap-panel-accepted-item-1"]')).not.toBeNull();
    });
    await waitForSettled();
    const post = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/correct') && (init as RequestInit)?.method === 'POST');
    expect(post).toBeTruthy();
    expect(container!.textContent).toMatch(/clears only when validation succeeds/);
  });

  it('shows the submitting state while the correction is in flight (T-8)', async () => {
    let release!: (res: Response) => void;
    fetchMock.mockImplementationOnce(async () => jsonResponse({ gap: GAP }));
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    await renderPanel();
    await act(async () => {
      fillDescription('Operator-supplied description');
    });
    await act(async () => {
      (container!.querySelector('[data-testid="gap-panel-submit-item-1"]') as HTMLButtonElement).click();
    });
    await vi.waitFor(() => {
      expect(container!.textContent).toMatch(/Submitting correction/);
    });
    expect(container!.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => {
      release(jsonResponse({
        gap: { ...GAP, correctionRevision: 1 },
        envelope: { revision: 1, status: 'recorded' },
        receiptId: 'receipt-1',
        replay: false,
      }));
    });
    await vi.waitFor(() => {
      expect(container!.querySelector('[data-testid="gap-panel-accepted-item-1"]')).not.toBeNull();
    });
    await waitForSettled();
  });

  it('stale_gap reloads the latest gap with product context intact (T-8)', async () => {
    const refreshed = { ...GAP, reason: 'Still missing a description — someone else recorded first.' };
    fetchMock.mockImplementationOnce(async () => jsonResponse({ gap: GAP }));
    fetchMock.mockImplementationOnce(async () => jsonResponse({ error: 'stale_gap', code: 'stale_gap' }, 409));
    fetchMock.mockImplementationOnce(async () => jsonResponse({ gap: refreshed }));
    await renderPanel();
    await act(async () => {
      fillDescription('Operator-supplied description');
    });
    await act(async () => {
      (container!.querySelector('[data-testid="gap-panel-submit-item-1"]') as HTMLButtonElement).click();
    });
    // The panel reloads instead of erroring: the form returns bound to
    // the latest gap, with the product name and the new reason visible.
    await vi.waitFor(() => {
      expect(container!.textContent).toMatch(/someone else recorded first/);
    });
    await waitForSettled();
    expect(container!.querySelector('form[aria-label="Correct listing information for Acana Food"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="gap-panel-error-item-1"]')).toBeNull();
    expect(container!.querySelector('#gap-item-1-description')).not.toBeNull();
  });
});
