/**
 * The four reverse-image engines, as data.
 *
 * Everything an engine needs — the URL to open, the flow for a local file, the selectors
 * for its result rows, the markers that mean it refused us — is a serialisable record here,
 * because the code that uses it runs in a different process (`browser-driver.ts`). Keeping
 * it declarative also means an engine that redesigns its page is a three-line edit in one
 * file rather than a rewrite, which matters: these pages change and the selectors below
 * will rot.
 *
 * ## Why these four, and what each is actually for
 *
 * They answer **different questions**, and treating them as four spellings of one search is
 * the mistake that makes reverse image search useless:
 *
 *  - **TinEye** answers *"where else does this exact file appear, and when did it first
 *    appear"*. It matches copies, not likenesses — a different photograph of the same
 *    person is a miss. The first-indexed date is the part nothing else here provides, and
 *    it is what turns "this avatar is also on that forum" into "this avatar was on that
 *    forum in 2014, before the account you started from existed".
 *  - **Yandex Images** answers *"which pages carry this picture"* and, separately, *"what
 *    else looks like it"*. Practitioners rate it highest for faces. Only its **Sites** list
 *    is harvested here — the similar-images panel is deliberately left alone, both because
 *    a likeness is not an identity and because harvesting faces that merely resemble a
 *    stranger is the PimEyes-shaped thing this project does not do.
 *  - **Bing Visual Search** answers *"what is this a picture of"*. Verified on this machine:
 *    it resolves the image to a text label and then runs a **text search** for that label —
 *    the final URL is literally `bing.com/search?q=Tux+Linux+Mascot`. Useful for
 *    identifying a stock image or a recognisable object; close to worthless for finding
 *    which accounts reuse an avatar. Its rows are therefore classed `similar`, which stops
 *    them from ever proposing an account.
 *  - **Google Lens** would answer the same question as Yandex, better. It has not answered
 *    once from this network — see `GOOGLE_LENS_NOTE`.
 *
 * PimEyes is absent on purpose and is not a gap to be filled later: it is a paid facial
 * recognition service built to resist exactly this, and running face search against
 * strangers is outside what this project does.
 */

import type { BrowserEngineSpec, BrowserStep } from './browser'

/** The engines that run unless the operator names others. Only the two that work. */
export const DEFAULT_ENGINES: readonly string[] = ['tineye', 'yandex']

/**
 * Written into the run summary whenever Google Lens is asked for, so the operator is not
 * left wondering. Measured on 2026-09-03 from this machine, headless *and* headed, with a
 * clean context each time.
 */
export const GOOGLE_LENS_NOTE =
  'Google Lens answered every attempt from this network with https://www.google.com/sorry/index ' +
  '("Our systems have detected unusual traffic from your computer network"), headless and headed alike, ' +
  'on a first request from a clean profile. Treat it as unavailable to automation rather than as flaky.'

/**
 * A fact an engine states in prose rather than in a row.
 *
 * TinEye's "First indexed by TinEye on February 5, 2008" is the reason to run TinEye at all
 * — it dates the earliest copy, which is what orders a set of accounts in time — and it is
 * one sentence of body text, not a list item. Reading it with a regex over the captured
 * page text rather than a CSS selector is the durable choice: TinEye's markup is Tailwind
 * output that changes with every redesign, and the wording of that sentence has not.
 *
 * The match runs inside `parse()`, over the text already stored in the envelope's
 * artifacts, so it stays pure and a capture from last month can be re-read when a pattern
 * is added.
 */
export interface TextHighlight {
  /** Source-form regex; the parser compiles it with the `i` flag. Capture group 1 is used. */
  pattern: string
  /** How the captured value reads in a claim. `{0}` is replaced by the capture. */
  claim: string
}

export interface ReverseEngine extends BrowserEngineSpec {
  title: string
  /** Prose facts worth a finding of their own. */
  textHighlights?: TextHighlight[]
  /** Can this engine be given a public image URL? */
  acceptsUrl: boolean
  /** Can a local file be uploaded to it? */
  acceptsFile: boolean
  /** One line for the run summary and the blocked-engine claim. */
  strength: string
  /** The steps used when the image is a public URL. */
  urlSteps: BrowserStep[]
  /** The steps used when the image is a local file. Empty means it cannot take one. */
  fileSteps: BrowserStep[]
}

/* ------------------------------------------------------------------ *
 * TinEye
 * ------------------------------------------------------------------ */

const tineye: ReverseEngine = {
  id: 'tineye',
  title: 'TinEye',
  site: 'tineye.com',
  selfHosts: ['tineye.com'],
  acceptsUrl: true,
  acceptsFile: true,
  strength: 'exact copies of this file, and the date it was first indexed',
  handoffUrl: 'https://tineye.com/search?url={IMAGE_URL_ENC}',
  urlSteps: [{ do: 'goto', url: 'https://tineye.com/search?url={IMAGE_URL_ENC}' }, { do: 'wait', ms: 3000 }],
  // The file input is `#upload-box`, permanently in the DOM and permanently off-screen
  // (`class="fixed -top-250"`). Playwright sets files on a hidden input directly, so the
  // camera button never has to be found or clicked.
  fileSteps: [
    { do: 'goto', url: 'https://tineye.com/' },
    // Shorter than Yandex's because TinEye's input is a plain form control that works
    // immediately, but not zero: the page is a single-page app and a submit handler that is
    // not yet attached is the one failure that looks exactly like an empty result.
    { do: 'wait', ms: 1500 },
    { do: 'upload', selector: 'input[type=file]' },
    { do: 'wait', ms: 4000 }
  ],
  steps: [],
  results: [
    {
      kind: 'same',
      // No stable class, id or data attribute survives on a TinEye result row — the markup
      // is Tailwind utility soup. Every off-site anchor is the honest selector here, and the
      // engine's own domain plus the shared chrome list keep the navigation out.
      selectors: ['a[href^="http"]']
    }
  ],
  readySelectors: [],
  readyText: ['tineye searched', 'no results', 'results'],
  summarySelectors: ['h2'],
  textHighlights: [
    {
      pattern: 'First indexed by TinEye on ([A-Z][a-z]+ \\d{1,2}, \\d{4})',
      claim:
        'TinEye first indexed this image on {0}. That is the earliest date it saw the picture anywhere, ' +
        'which puts a floor under how old the file is and orders the copies in time — an account that had ' +
        'it before that date did not get it from any of the pages below. It is a lower bound only: TinEye ' +
        'indexes what it crawls, so the picture may have existed for years before this.'
    }
  ],
  block: { urlContains: [], selectors: [], textContains: [] }
}

/* ------------------------------------------------------------------ *
 * Yandex Images
 * ------------------------------------------------------------------ */

const yandex: ReverseEngine = {
  id: 'yandex',
  title: 'Yandex Images',
  site: 'yandex.com',
  selfHosts: ['yandex.com', 'yandex.ru', 'yandex.net', 'ya.ru'],
  acceptsUrl: true,
  acceptsFile: true,
  strength: 'the pages that carry this picture, and the widest catalogue for faces',
  handoffUrl: 'https://yandex.com/images/search?rpt=imageview&url={IMAGE_URL_ENC}',
  // `cbir_page=sites` is asked for in the first navigation rather than after it: the Sites
  // list is the only part harvested, and going straight there is one request instead of two.
  urlSteps: [
    { do: 'goto', url: 'https://yandex.com/images/search?rpt=imageview&cbir_page=sites&url={IMAGE_URL_ENC}' },
    { do: 'wait', ms: 4000 }
  ],
  // Uploading produces a Yandex-hosted copy of the image and a URL nobody can predict, so
  // the Sites tab has to be reached by re-navigating to whatever the upload landed on with
  // one extra query parameter. That is what `gotoCurrentWith` is for.
  fileSteps: [
    { do: 'goto', url: 'https://yandex.com/images/' },
    // Yandex's upload panel is wired up by script after `domcontentloaded`. Uploading into
    // it before then puts the file on an input whose change handler does not exist yet: the
    // call succeeds, nothing navigates, and the run comes back with an empty Sites list for
    // a picture the URL flow matches seventeen times. Measured — three and a half seconds
    // is the difference between four rows and none.
    { do: 'wait', ms: 3500 },
    { do: 'upload', selector: 'input.CbirCore-FileInput, input[type=file]', click: 'button[aria-label*="mage" i]' },
    // The upload is answered by a client-side navigation, and a fixed sleep loses that race
    // often enough to matter: the first live run's `gotoCurrentWith` fired against
    // `yandex.com/images/`, landed on the gallery, found no rows, and reported an honest-
    // looking "no matches" for a picture Yandex had in fact matched seventeen times.
    { do: 'waitForUrl', contains: 'rpt=imageview', ms: 30_000 },
    { do: 'wait', ms: 2000 },
    { do: 'gotoCurrentWith', params: { cbir_page: 'sites' } },
    { do: 'wait', ms: 3000 }
  ],
  steps: [],
  results: [
    {
      kind: 'same',
      // The domain anchor, not the `.CbirSites-Item` row that contains it. The row is more
      // attractive — it carries the page title and a snippet — but its *first* anchor is
      // sometimes the thumbnail, and taking that yields a CDN path for the picture where a
      // page URL was wanted. Measured: the row selector turned half of an upload's results
      // into `sun9-38.userapi.com/...jpg` instead of the pages those thumbnails sat on. The
      // row is kept as the fallback for the day the domain class is renamed, when a slightly
      // wrong URL beats no result at all.
      selectors: ['a.CbirSites-ItemDomain', '.CbirSites-Item']
    }
  ],
  // Deliberately narrow, and this is the lesson from the same failure: the tab strip
  // (`.CbirNavigation-TabsItem`) and the word "sites" are on every Yandex image page,
  // including the ones that hold no Sites list at all, so accepting either as proof that the
  // engine answered turns a navigation failure into a false empty result. Only the Sites
  // container itself, or Yandex's own empty-state wording, counts.
  readySelectors: ['.CbirSites-Item', '.CbirSites', '.CbirSitesList'],
  readyText: ['nothing found', 'ничего не найдено', 'no matching', 'no results found'],
  summarySelectors: ['.CbirSites-Title'],
  block: {
    urlContains: ['showcaptcha', 'checkcaptcha'],
    selectors: ['.CheckboxCaptcha', 'form[action*="checkcaptcha"]'],
    textContains: []
  }
}

/* ------------------------------------------------------------------ *
 * Bing Visual Search
 * ------------------------------------------------------------------ */

const bing: ReverseEngine = {
  id: 'bing',
  title: 'Bing Visual Search',
  site: 'bing.com',
  selfHosts: ['bing.com', 'microsoft.com', 'msn.com', 'live.com'],
  acceptsUrl: true,
  acceptsFile: false,
  strength: 'naming what the picture is of, rather than finding where it appears',
  handoffUrl:
    'https://www.bing.com/images/search?view=detailv2&iss=sbi&form=SBIVSP&sbisrc=UrlPaste&q=imgurl:{IMAGE_URL_ENC}',
  urlSteps: [
    {
      do: 'goto',
      url: 'https://www.bing.com/images/search?view=detailv2&iss=sbi&form=SBIVSP&sbisrc=UrlPaste&q=imgurl:{IMAGE_URL_ENC}'
    },
    { do: 'wait', ms: 5000 }
  ],
  fileSteps: [],
  steps: [],
  results: [
    {
      // `similar`, not `same`: Bing hands back the pages about the *thing it decided the
      // picture is*, which is a different claim from "this file is on that page".
      kind: 'similar',
      selectors: ['#b_content a[href^="http"]', 'a[href^="http"]']
    }
  ],
  readySelectors: ['#b_content', '#b_results'],
  readyText: ['visual matches', 'pages with this image', 'no results'],
  summarySelectors: [],
  block: { urlContains: [], selectors: [], textContains: [] }
}

/* ------------------------------------------------------------------ *
 * Google Lens
 * ------------------------------------------------------------------ */

const google: ReverseEngine = {
  id: 'google',
  title: 'Google Lens',
  site: 'lens.google.com',
  selfHosts: ['google.com', 'lens.google.com', 'gstatic.com', 'googleusercontent.com', 'youtube.com'],
  acceptsUrl: true,
  acceptsFile: false,
  strength: 'the broadest index, when it answers at all',
  handoffUrl: 'https://lens.google.com/uploadbyurl?url={IMAGE_URL_ENC}',
  urlSteps: [
    { do: 'goto', url: 'https://lens.google.com/uploadbyurl?url={IMAGE_URL_ENC}' },
    { do: 'wait', ms: 5000 }
  ],
  fileSteps: [],
  steps: [],
  results: [{ kind: 'similar', selectors: ['div[role="main"] a[href^="http"]', 'a[href^="http"]'] }],
  readySelectors: [],
  readyText: ['visual matches', 'exact matches', 'about this image'],
  summarySelectors: [],
  block: {
    urlContains: ['/sorry/'],
    selectors: [],
    // Google's EU consent wall is a block like any other. This adapter never accepts terms
    // on the operator's behalf; it reports the wall and hands back a URL.
    textContains: ['before you continue']
  }
}

/* ------------------------------------------------------------------ *
 * The set
 * ------------------------------------------------------------------ */

/** Ordered as practitioners rate them for person matching, best first. */
export const REVERSE_ENGINES: readonly ReverseEngine[] = [yandex, google, bing, tineye]

export function engineById(id: string): ReverseEngine | undefined {
  return REVERSE_ENGINES.find((e) => e.id === id.trim().toLowerCase())
}

/**
 * Turn an engine into the spec the driver executes, binding the flow for the input we
 * actually have. `null` means this engine cannot take this kind of input.
 */
export function specFor(engine: ReverseEngine, mode: 'url' | 'file'): BrowserEngineSpec | null {
  const steps = mode === 'file' ? engine.fileSteps : engine.urlSteps
  if (steps.length === 0) return null
  return {
    id: engine.id,
    site: engine.site,
    selfHosts: [...engine.selfHosts],
    handoffUrl: engine.handoffUrl,
    steps,
    results: engine.results.map((r) => ({ kind: r.kind, selectors: [...r.selectors] })),
    readySelectors: [...(engine.readySelectors ?? [])],
    readyText: [...(engine.readyText ?? [])],
    summarySelectors: [...(engine.summarySelectors ?? [])],
    block: {
      urlContains: [...(engine.block?.urlContains ?? [])],
      selectors: [...(engine.block?.selectors ?? [])],
      textContains: [...(engine.block?.textContains ?? [])]
    }
  }
}
