// Level look (design 3.6): colour from the level only, plus an icon and a word, so greyscale and
// colour-blind viewers still tell the levels apart. A quiet card (estimate, unverified) never uses these.
export interface LevelView { word: string; icon: string; box: string }

export function levelView(level: string | null): LevelView {
  switch (level) {
    case 'NORMAL': return { word: 'OK', icon: '✓', box: 'bg-level-normal text-white' };
    case 'WARNING': return { word: 'WARNING', icon: '▲', box: 'bg-level-warning text-ink' };
    case 'DANGER': return { word: 'DANGER', icon: '✖', box: 'bg-level-danger text-white' };
    default: return { word: level === null ? 'NO DATA' : 'NOTICE', icon: '•', box: 'bg-stale-fill text-stale-text' };
  }
}
