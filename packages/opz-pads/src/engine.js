export const PAD_NOTE = 48;
export const PAD_LEDS = [94, 96, 98, 100, 86, 88, 90, 92, 78, 80, 82, 84, 70, 72, 74, 76];
export const TRACK_COLORS = [[127, 100], [127, 0], [127, 35], [0, 127]];
const clamp = (value) => Math.max(0, Math.min(127, value));
const scene = (type) => ({ type, pads: Array.from({ length: 16 }, () => null) });

export function newProject() {
  return { version: 1, scenes: [scene('mixer'), ...Array.from({ length: 15 }, () => scene('empty'))] };
}

export function validateProject(project) {
  if (!project || project.version !== 1 || !Array.isArray(project.scenes) || project.scenes.length !== 16) return false;
  return project.scenes.every((item, index) =>
    item && (index === 0 ? item.type === 'mixer' : ['empty', 'drum'].includes(item.type)) &&
    Array.isArray(item.pads) && item.pads.length === 16 && item.pads.every((pad) =>
      pad === null || (item.type === 'drum' && Number.isInteger(pad.channel) && pad.channel >= 0 && pad.channel < 4 &&
        Number.isInteger(pad.note) && pad.note >= 0 && pad.note <= 127 &&
        Number.isInteger(pad.velocity) && pad.velocity >= 0 && pad.velocity <= 127)));
}

export class Engine {
  constructor({ send, changed, save }) {
    this.send = send;
    this.changed = changed;
    this.save = save;
    this.project = newProject();
    this.scene = 0;
    this.held = Array(16).fill(false);
    this.pressure = Array(16).fill(0);
    this.buttons = [false, false];
    this.push = false;
    this.fader = 127;
    this.controls = new Map();
    this.playing = new Map();
    this.transport = 'unknown';
    this.values = Array.from({ length: 16 }, () => Array(16).fill(null));
    this.history = Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => []));
    this.auditions = new Map();
  }

  setProject(project) {
    if (!validateProject(project)) throw new Error('Invalid or unsupported project file');
    this.releaseAll();
    this.project = project;
    this.update(true);
  }

  setType(index, type) {
    if (index < 1 || index > 15 || !['empty', 'drum'].includes(type)) throw new Error('Invalid scene type');
    if (index === this.scene) this.releaseAll();
    this.project.scenes[index] = scene(type);
    this.update(true);
  }

  releaseAll() {
    for (const note of this.playing.values()) this.send('opz', [0x80 + note.channel, note.note, 0]);
    this.playing.clear();
    for (const timer of this.auditions.values()) {
      clearInterval(timer.interval);
      clearTimeout(timer.timeout);
    }
    this.auditions.clear();
    this.held.fill(false);
    this.pressure.fill(0);
    this.buttons.fill(false);
    this.push = false;
  }

  selectScene(index) {
    if (index < 0 || index > 15 || index === this.scene) return;
    this.releaseAll();
    this.scene = index;
    this.controls.clear();
    this.update();
  }

  leds() {
    const current = this.project.scenes[this.scene];
    return current.pads.map((pad, index) => {
      if (current.type === 'mixer') return [0, 0];
      if (!pad) return [0, 0];
      const factor = this.held[index] ? 1 : 0.45;
      return TRACK_COLORS[pad.channel].map((value) => Math.round(value * factor));
    });
  }

  refreshLeds() {
    this.leds().forEach(([red, green], index) => {
      this.send('irig', [0xb0, PAD_LEDS[index], green]);
      this.send('irig', [0xb0, PAD_LEDS[index] + 1, red]);
    });
  }

  update(persist = false) {
    if (persist) this.save(this.project);
    this.refreshLeds();
    this.changed();
  }

  irig(data) {
    const [status, a, b] = data;
    if (status === undefined) return;
    const kind = status & 0xf0;
    const channel = status & 15;
    if (kind === 0xc0 && a >= 0 && a < 16) {
      this.selectScene(a);
      this.refreshLeds();
      return;
    }
    if ((kind === 0x90 || kind === 0x80) && a === PAD_NOTE && b !== undefined) {
      const on = kind === 0x90 && b > 0;
      this.pad(channel, on, b);
      return;
    }
    if (kind === 0xd0 && a !== undefined && this.held[channel]) {
      this.pressure[channel] = a;
      this.changed();
      return;
    }
    if (kind !== 0xb0 || channel !== 0 || a === undefined || b === undefined) return;
    if (a === 20 || a === 21) {
      const index = a - 20;
      if (b === 0) this.buttons[index] = false;
      else if (!this.buttons[1 - index]) this.buttons[index] = true;
      this.changed();
      return;
    }
    if (a === 22) {
      this.push = b > 0;
      this.changed();
      return;
    }
    if (![1, 7, 10, 11].includes(a)) return;
    if (a === 1) this.fader = b;
    const previous = this.controls.get(a);
    this.controls.set(a, b);
    const delta = a === 7 ? (b >= 64 ? b - 128 : b) : previous === undefined ? 0 : b - previous;
    if ((delta || (a === 1 && !this.buttons[0] && !this.buttons[1])) &&
        this.project.scenes[this.scene].type === 'drum') this.drumControl(a, delta, b);
    this.changed();
  }

  pad(index, on, velocity) {
    if (this.held[index] === on) return;
    this.held[index] = on;
    this.pressure[index] = on ? velocity : 0;
    const current = this.project.scenes[this.scene];
    if (current.type === 'drum') {
      const pad = current.pads[index];
      if (on && pad) {
        this.send('opz', [0x90 + pad.channel, pad.note, Math.max(1, Math.round(velocity * pad.velocity / 127))]);
        this.playing.set(index, { ...pad });
      } else if (!on && this.playing.has(index)) {
        const audition = this.auditions.get(index);
        if (audition) {
          clearInterval(audition.interval);
          clearTimeout(audition.timeout);
          this.auditions.delete(index);
        }
        const note = this.playing.get(index);
        this.send('opz', [0x80 + note.channel, note.note, 0]);
        this.playing.delete(index);
      }
    }
    this.update();
  }

  drumControl(control, delta, value) {
    const current = this.project.scenes[this.scene];
    const modifier = this.buttons[0] ? 1 : this.buttons[1] ? 2 : 0;
    const table = [
      { 10: 1, 11: 2, 7: this.push ? 4 : 3 },
      { 10: 5, 11: 6, 7: this.push ? 8 : 7, 1: 9 },
      { 10: 13, 11: 14, 7: this.push ? 16 : 15, 1: 9 },
    ];
    let dirty = false;
    const adjustedChannels = new Set();
    this.held.forEach((held, index) => {
      const pad = current.pads[index];
      if (!held || !pad) return;
      if (control === 1 && modifier === 0) {
        pad.velocity = value;
        dirty = true;
        return;
      }
      const cc = table[modifier][control];
      if (!cc) return;
      if (!adjustedChannels.has(pad.channel)) {
        for (let i = 0; i < Math.min(Math.abs(delta), 127); i++) {
          this.send('opz', [0xb0 + pad.channel, cc + 31, delta > 0 ? 1 : 127]);
        }
        adjustedChannels.add(pad.channel);
      }
      this.audition(index, pad);
    });
    if (dirty) this.update(true);
  }

  audition(index, pad) {
    const previous = this.auditions.get(index);
    if (previous) {
      clearTimeout(previous.timeout);
      previous.timeout = setTimeout(() => this.stopAudition(index), 200);
      return;
    }
    const repeat = () => {
      this.send('opz', [0x80 + pad.channel, pad.note, 0]);
      this.send('opz', [0x90 + pad.channel, pad.note, Math.max(1, pad.velocity)]);
      this.playing.set(index, { ...pad });
    };
    repeat();
    this.auditions.set(index, {
      interval: setInterval(repeat, 120),
      timeout: setTimeout(() => this.stopAudition(index), 200),
    });
  }

  stopAudition(index) {
    const audition = this.auditions.get(index);
    if (!audition) return;
    clearInterval(audition.interval);
    clearTimeout(audition.timeout);
    const pad = this.playing.get(index);
    if (pad) {
      this.send('opz', [0x80 + pad.channel, pad.note, 0]);
      this.playing.delete(index);
    }
    this.auditions.delete(index);
  }

  opz(data) {
    const [status, a, b] = data;
    if (status === undefined) return;
    if (status === 0xfa || status === 0xfb || status === 0xfc) {
      this.transport = status === 0xfc ? 'stopped' : 'running';
      this.changed();
      return;
    }
    const kind = status & 0xf0;
    const channel = status & 15;
    if (kind === 0xb0 && a >= 1 && a <= 16 && b !== undefined) {
      this.values[channel][a - 1] = b;
      const history = this.history[channel][a - 1];
      history.push({ time: Date.now(), before: b, after: b });
      if (history.length > 100) history.shift();
      this.changed();
    }
    if (kind === 0x90 && b > 0 && a !== undefined && channel < 4 && this.transport === 'stopped') {
      const current = this.project.scenes[this.scene];
      if (current.type === 'drum') {
        let dirty = false;
        this.held.forEach((held, index) => {
          if (!held) return;
          this.stopAudition(index);
          const playing = this.playing.get(index);
          if (playing) {
            this.send('opz', [0x80 + playing.channel, playing.note, 0]);
            this.playing.delete(index);
          }
          current.pads[index] = { channel, note: clamp(a), velocity: 127 };
          dirty = true;
        });
        if (dirty) this.update(true);
      }
    }
  }
}
