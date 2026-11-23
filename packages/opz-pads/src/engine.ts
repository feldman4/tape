import { ControllerState } from './controller.ts';
import { decodeIrig, decodeMidi } from './midi.ts';
import { newProject, newScene, validateProject } from './model.ts';
import type { EditableSceneType, Project, Scene } from './model.ts';
import { DrumHandler, InactiveHandler } from './scenes.ts';
import type { Led, SceneEvent, SceneHandler, Send, Transport } from './scenes.ts';

export { newProject, validateProject } from './model.ts';

const PAD_LEDS = [94, 96, 98, 100, 86, 88, 90, 92, 78, 80, 82, 84, 70, 72, 74, 76];
type HistoryEntry = { time: number; before: number; after: number };
type Handlers = { [K in Scene['type']]: SceneHandler<Extract<Scene, { type: K }>> };

export class Engine {
  project = newProject();
  scene = 0;
  transport: Transport = 'unknown';
  readonly values = Array.from({ length: 16 }, () => Array<number | null>(16).fill(null));
  readonly history = Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => Array<HistoryEntry>()));
  private readonly controller = new ControllerState();
  private readonly handlers: Handlers;
  private lastLeds: Led[] | null = null;
  private readonly send: Send;
  private readonly changed: () => void;
  private readonly save: (project: Project) => void;

  constructor({ send, changed, save }: { send: Send; changed: () => void; save: (project: Project) => void }) {
    this.send = send;
    this.changed = changed;
    this.save = save;
    this.handlers = {
      mixer: new InactiveHandler(),
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
    this.handlers[this.current.type].release();
    this.controller.release();
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

  refreshLeds(force = true): void {
    const leds = this.leds();
    leds.forEach(([red, green], index) => {
      const previous = this.lastLeds?.[index];
      if (force || !previous || previous[1] !== green) this.send('irig', [0xb0, PAD_LEDS[index], green]);
      if (force || !previous || previous[0] !== red) this.send('irig', [0xb0, PAD_LEDS[index] + 1, red]);
    });
    this.lastLeds = leds.map(([red, green]) => [red, green]);
  }

  private update(persist = false): void {
    if (persist) this.save(this.project);
    this.refreshLeds(false);
    this.changed();
  }

  irig(data: ArrayLike<number>, time = performance.now()): void {
    const event = decodeIrig(data);
    if (!event) return;
    switch (event.type) {
      case 'scene':
        this.selectScene(event.index);
        this.refreshLeds();
        return;
      case 'pad':
        if (this.held[event.index] === event.on) return;
        this.held[event.index] = event.on;
        this.pressure[event.index] = event.on ? event.velocity : 0;
        this.handle({ ...event, time });
        this.update();
        return;
      case 'pressure':
        if (this.held[event.index]) {
          this.pressure[event.index] = event.value;
          this.handle({ ...event, time });
          this.update();
        }
        return;
      case 'button':
        this.controller.button(event.index, event.pressed);
        this.handle({ ...event, time });
        this.update();
        return;
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
    if (!event) return;
    if (event.type === 'transport') {
      this.transport = event.state;
      this.changed();
      this.handle({ type: 'midi', event, transport: this.transport, time });
      return;
    }
    if (event.type === 'control' && event.controller >= 1 && event.controller <= 16) {
      this.values[event.channel][event.controller - 1] = event.value;
      const history = this.history[event.channel][event.controller - 1];
      history.push({ time: Date.now(), before: event.value, after: event.value });
      if (history.length > 100) history.shift();
      this.changed();
    }
    this.handle({ type: 'midi', event, transport: this.transport, time });
  }
}
