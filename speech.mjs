export function cleanSpeech(text) {
  return text.replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'the linked page')
    .replace(/`([^`]+)`/g, '$1').replace(/^\s*[#>*-]+\s*/gm, '')
    .replace(/[*_~]/g, '').replace(/\s+/g, ' ').trim();
}

// Re-evaluate the full text so incomplete fenced code is never narrated.
export class SpeechSegments {
  constructor(emit) { this.emit = emit; this.raw = ''; this.spoken = 0; }
  push(delta) { this.raw += delta; this.flush(false); }
  // For hosts that report the whole message text on each update instead of deltas.
  update(text) { this.raw = text; this.flush(false); }
  flush(final) {
    const clean = cleanSpeech(this.raw);
    let remaining = clean.slice(this.spoken);
    while (remaining.length) {
      const end = [...remaining.matchAll(/[.!?](?=\s|$)/g)].find(match => match.index >= 35 && match.index < 260)?.index;
      let cut = end !== undefined ? end + 1 : -1;
      if (cut < 0 && remaining.length > 260) { const space = remaining.lastIndexOf(' ', 240); cut = space > 0 ? space : 240; }
      if (cut < 0 && final) cut = remaining.length;
      if (cut <= 0) break;
      const segment = remaining.slice(0, cut).trim();
      this.spoken += cut;
      if (segment) this.emit(segment);
      remaining = clean.slice(this.spoken);
    }
  }
  reset() { this.raw = ''; this.spoken = 0; }
}
