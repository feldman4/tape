import { ControllerState } from './controller.ts';
import { padLedMessages } from './irig.ts';
import { decodeIrig, decodeMidi } from './midi.ts';
import { newProject, newScene, validateProject } from './model.ts';
import { MixerHandler } from './mixer.ts';
import type { EditableSceneType, Project, Scene } from './model.ts';
import { DrumHandler, InactiveHandler } from './scenes.ts';
import type { Led, SceneEvent, SceneHandler, Send, Transport } from './scenes.ts';

export { newProject, validateProject } from './model.ts';

type HistoryEntry = { time: number; before: number; after: number };
type Handlers = { [K in Scene['type']]: SceneHandler<Extract<Scene, { type: K }>> };
const pressureLedInterval = 50;
const releaseLedDelay = 200;

export class Engine {
  project = newProject();
  scene = 0;
  transport: Transport = 'unknown';
  readonly values = Array.from({ length: 16 }, () => Array<number | null>(16).fill(null));
  readonly history = Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => Array<HistoryEntry>()));
  private readonly controller = new ControllerState();
  readonly mixer: MixerHandler;
  private readonly handlers: Handlers;
  private readonly lastLeds: (Led | null)[] = Array(16).fill(null);
  private readonly pendingPressureLeds = new Set<number>();
  private pressureLedTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly releaseLedTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly send: Send;
  private readonly changed: () => void;
  private readonly save: (project: Project) => void;

  constructor({ send, changed, save }: { send: Send; changed: () => void; save: (project: Project) => void }) {
    this.send = send;
    this.changed = changed;
    this.save = save;
    this.mixer = new MixerHandler(send, () => this.update());
    this.handlers = {
      mixer: this.mixer,
      empty: new InactiveHandler(),
      drum: new DrumHandler(send, () => this.update(true)),
    };
  }

  get held(): boolean[] { return this.controller.held; }
  get pressure(): number[] { return this.controller.pressure; }
  get buttons(): [boolean, boolean] { return this.controller.buttons; }
  get push(): boolean { return this.controller.push; }
  get fader(): number { return this.controller.fader; }
  private get current(): Scene { return this.project.scenes[this.scene]; }
  private handle(event: SceneEvent): void {
    const scene = this.current;
    switch (scene.type) {
      case 'mixer': this.handlers.mixer.handle(scene, this.controller, event); break;
      case 'empty': this.handlers.empty.handle(scene, this.controller, event); break;
      case 'drum': this.handlers.drum.handle(scene, this.controller, event); break;
    }
  }

  setProject(project: unknown): void {
    if (!validateProject(project)) throw new Error('Invalid or unsupported project file');
    this.releaseAll();
    this.project = project;
    this.update(true);
  }

  setType(index: number, type: EditableSceneType): void {
    if (!Number.isInteger(index) || index < 1 || index > 15 || (type !== 'empty' && type !== 'drum')) {
      throw new Error('Invalid scene type');
    }
    if (index === this.scene) this.releaseAll();
    this.project.scenes[index] = newScene(type);
    this.update(true);
  }

  releaseAll(): void {
    this.cancelPressureLeds();
    this.handlers[this.current.type].release();
    this.controller.release();
  }

  cancelReleaseLedRefreshes(): void {
    for (const timer of this.releaseLedTimers) clearTimeout(timer);
    this.releaseLedTimers.clear();
  }

  resetOpz(): void {
    this.transport = 'unknown';
    this.mixer.reset();
    for (const row of this.values) row.fill(null);
    for (const row of this.history) for (const entries of row) entries.length = 0;
    this.update();
  }

  selectScene(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index > 15 || index === this.scene) return;
    this.releaseAll();
    this.scene = index;
    this.controller.resetControls();
    this.update();
  }

  leds(): [number, number][] {
    const scene = this.current;
    switch (scene.type) {
      case 'mixer': return this.handlers.mixer.leds(scene, this.controller);
      case 'empty': return this.handlers.empty.leds(scene, this.controller);
      case 'drum': return this.handlers.drum.leds(scene, this.controller);
    }
  }

  refreshLeds(force = true, forcePad?: number | ReadonlySet<number>): void {
    if (force) this.cancelPressureLeds();
    const leds = this.leds();
    leds.forEach(([red, green], index) => {
      const previous = this.lastLeds[index];
      const [greenMessage, redMessage] = padLedMessages(index, [red, green]);
      const refreshPad = typeof forcePad === 'number' ? index === forcePad : forcePad?.has(index);
      if (!force && !refreshPad && this.pendingPressureLeds.has(index)) return;
      if (force || refreshPad || !previous || previous[1] !== green) this.send('irig', greenMessage);
      if (force || refreshPad || !previous || previous[0] !== red) this.send('irig', redMessage);
      this.lastLeds[index] = [red, green];
    });
  }

  private cancelPressureLeds(index?: number): void {
    if (index === undefined) this.pendingPressureLeds.clear();
    else this.pendingPressureLeds.delete(index);
    if (this.pendingPressureLeds.size === 0) {
      clearTimeout(this.pressureLedTimer);
      this.pressureLedTimer = undefined;
    }
  }

  private schedulePressureLed(index: number): void {
    this.pendingPressureLeds.add(index);
    if (this.pressureLedTimer !== undefined) return;
    this.pressureLedTimer = setTimeout(() => {
      this.pressureLedTimer = undefined;
      const pads = new Set(this.pendingPressureLeds);
      this.pendingPressureLeds.clear();
      this.refreshLeds(false, pads);
    }, pressureLedInterval);
  }

  private update(persist = false, forcePad?: number): void {
    if (persist) this.save(this.project);
    this.refreshLeds(false, forcePad);
    this.changed();
  }

  irig(data: ArrayLike<number>, time = performance.now()): void {
    const event = decodeIrig(data);
    if (!event) return;
    if (event.type === 'pad' && !event.on) {
      const timer = setTimeout(() => {
        this.releaseLedTimers.delete(timer);
        this.refreshLeds(false, event.index);
      }, releaseLedDelay);
      this.releaseLedTimers.add(timer);
    }
    if ('scene' in event && event.scene !== this.scene) {
      this.selectScene(event.scene);
      this.refreshLeds();
    }
    switch (event.type) {
      case 'pad':
        this.cancelPressureLeds(event.index);
        if (this.held[event.index] === event.on) {
          this.refreshLeds(false, event.index);
        } else {
          this.held[event.index] = event.on;
          this.pressure[event.index] = event.on ? event.velocity : 0;
          const previousGroup = this.mixer.group;
          this.handle({ ...event, time });
          if (this.current.type === 'mixer' && this.buttons[1] && this.mixer.group !== previousGroup) {
            this.refreshLeds();
            this.changed();
          } else this.update(false, event.index);
        }
        return;
      case 'pressure':
        if (this.held[event.index]) {
          this.pressure[event.index] = event.value;
          this.handle({ ...event, time });
          this.changed();
        }
        this.schedulePressureLed(event.index);
        return;
      case 'button': {
        const groupDisplay = this.buttons[1];
        this.controller.button(event.index, event.pressed);
        this.handle({ ...event, time });
        if (this.current.type === 'mixer' && groupDisplay !== this.buttons[1]) {
          this.refreshLeds();
          this.changed();
        } else this.update();
        return;
      }
      case 'push':
        this.controller.push = event.pressed;
        this.handle({ ...event, time });
        this.update();
        return;
      case 'control': {
        const delta = this.controller.move(event.control, event.value);
        this.handle({ ...event, delta, time });
        this.update();
      }
    }
  }

  opz(data: ArrayLike<number>, time = performance.now()): void {
    const event = decodeMidi(data);
    const forwarded = Array.from(data);
    if (event?.type === 'control' && event.controller === 16) {
      forwarded[2] = this.mixer.scaledLevel(event.channel, event.value);
    }
    this.send('iac', forwarded);
    if (!event) return;
    const previousGroup = this.mixer.group;
    this.mixer.receive(event);
    if (event.type === 'transport') {
      this.transport = event.state;
      this.changed();
      this.handle({ type: 'midi', event, transport: this.transport, time });
      return;
    }
    if (event.type === 'control' && event.controller >= 1 && event.controller <= 16) {
      this.values[event.channel][event.controller - 1] = event.value;
      const history = this.history[event.channel][event.controller - 1];
      history.push({ time: Date.now(), before: event.value, after: forwarded[2] });
      if (history.length > 100) history.shift();
      this.changed();
    }
    this.handle({ type: 'midi', event, transport: this.transport, time });
    if (event.type === 'program' || (event.type === 'control' && [15, 16, 53, 55, 103].includes(event.controller))) {
      this.refreshLeds(this.current.type === 'mixer' && this.buttons[1] && this.mixer.group !== previousGroup);
      this.changed();
    }
  }
}
