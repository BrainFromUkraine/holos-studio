// Plays the recordings from the engine and jumps over the removed parts (cuts, pauses, trimmed silence), so every
// edit is heard at once. "result": the processed copy of each recording (breaths, mouth clicks, voice chain,
// loudness — made like the export, see engine/src/holos/preview.py). "original": the recordings as they are, whole.

import { engine } from "@/lib/engine";
import { keptPieces, type Timeline } from "@/lib/timeline";

type Piece = { sid: string; a: number; b: number };
export type Pos = { sid: string; t: number };

export class Player {
  private audio: HTMLAudioElement;
  private plan: Piece[] = [];
  private idx = 0;
  private sid: string | null = null;
  private url = "";
  private raf = 0;
  private stopAt: Pos | null = null;
  private tl: Timeline | null = null;
  playing = false;
  mode: "result" | "original" = "result";
  onTick: (p: Pos) => void = () => {};
  onState: (playing: boolean) => void = () => {};

  constructor(private path: string) {
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.audio.addEventListener("ended", () => this.next());
  }

  setTimeline(tl: Timeline) {
    this.tl = tl;
    this.rebuild();
    void this.reloadIfChanged();
  }

  setMode(m: "result" | "original") {
    this.mode = m;
    this.rebuild();
    void this.reloadIfChanged();
  }

  private urlFor(sid: string): string {
    const s = this.tl?.sources.find((x) => x.id === sid);
    return engine.audioUrl(this.path, sid, this.mode === "result" ? s?.preview : undefined);
  }

  /** The sound of the recording being played changed (new processed copy, or the mode): continue in the new one. */
  private async reloadIfChanged() {
    const pos = this.position();
    if (!pos || !this.playing || this.urlFor(pos.sid) === this.url) return;
    try {
      await this.load(pos.sid, pos.t);
      if (this.playing) await this.audio.play();
    } catch {
      this.pause();
    }
  }

  private rebuild() {
    if (!this.tl) return;
    this.plan = [];
    for (const s of this.tl.sources) {
      const pieces: [number, number][] = this.mode === "result" ? keptPieces(s) : [[0, s.duration]];
      for (const [a, b] of pieces) if (b - a > 0.005) this.plan.push({ sid: s.id, a, b });
    }
    if (this.playing) {
      const pos = this.position();
      if (pos) this.idx = this.find(pos);
    }
  }

  private find(p: Pos): number {
    const order = this.tl?.sources.map((s) => s.id) ?? [];
    const si = order.indexOf(p.sid);
    for (let i = 0; i < this.plan.length; i++) {
      const pc = this.plan[i];
      const pi = order.indexOf(pc.sid);
      if (pi > si || (pi === si && pc.b > p.t + 0.001)) return i;
    }
    return this.plan.length;
  }

  position(): Pos | null {
    return this.sid ? { sid: this.sid, t: this.audio.currentTime } : null;
  }

  private async load(sid: string, t: number) {
    const url = this.urlFor(sid);
    if (this.url !== url) {
      this.sid = sid;
      try {
        await this.open(url);
      } catch (e) {
        // the processed copy could not be made: play the recording itself rather than nothing
        const raw = engine.audioUrl(this.path, sid);
        if (url === raw) throw e;
        await this.open(raw);
      }
    }
    this.audio.currentTime = t;
  }

  private open(url: string): Promise<void> {
    this.url = url;
    this.audio.src = url;
    return new Promise<void>((res, rej) => {
      const ok = () => { cleanup(); res(); };
      const bad = () => { cleanup(); rej(new Error("audio")); };
      const cleanup = () => { this.audio.removeEventListener("loadedmetadata", ok); this.audio.removeEventListener("error", bad); };
      this.audio.addEventListener("loadedmetadata", ok);
      this.audio.addEventListener("error", bad);
    });
  }

  /** Play from a source position; `until` stops there (used for "listen to this edit"). */
  async play(from: Pos, until: Pos | null = null) {
    this.stopAt = until;
    this.idx = this.find(from);
    const pc = this.plan[this.idx];
    if (!pc) return;
    const t = pc.sid === from.sid && from.t >= pc.a ? from.t : pc.a;
    try {
      await this.load(pc.sid, t);
      this.audio.volume = 1;
      await this.audio.play();
    } catch {
      return;
    }
    this.playing = true;
    this.onState(true);
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (!this.playing) return;
      this.watch();
      const p = this.position();
      if (p) this.onTick(p);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause() {
    this.playing = false;
    this.audio.pause();
    cancelAnimationFrame(this.raf);
    this.onState(false);
  }

  private watch() {
    const pc = this.plan[this.idx];
    const t = this.audio.currentTime;
    if (this.stopAt && this.sid === this.stopAt.sid && t >= this.stopAt.t) {
      this.pause();
      return;
    }
    if (pc && this.sid === pc.sid && t >= pc.b - 0.004) this.next();
  }

  private async next() {
    this.idx += 1;
    const pc = this.plan[this.idx];
    if (!pc) {
      this.pause();
      return;
    }
    if (pc.sid === this.sid) {
      // jump over a removed part; a tiny dip avoids a click at the splice
      this.audio.volume = 0.2;
      this.audio.currentTime = pc.a;
      setTimeout(() => (this.audio.volume = 1), 12);
      return;
    }
    this.audio.pause();
    try {
      await this.load(pc.sid, pc.a);
      if (this.playing) await this.audio.play();
    } catch {
      this.pause();
    }
  }

  destroy() {
    this.pause();
    this.audio.src = "";
    this.url = "";
  }
}
