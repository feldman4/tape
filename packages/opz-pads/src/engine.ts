import { ControllerState } from './controller.ts';
import { padLedMessages } from './irig.ts';
import { decodeIrig, decodeMidi } from './midi.ts';
import { newProject, newScene, validateCustomSlots, validateDrumScene, validateProject } from './model.ts';
import { MixerHandler } from './mixer.ts';
import type { CustomSlot, EditableSceneType, Project, Scene } from './model.ts';
import { PerformanceFxHandler } from './performance-fx.ts';
import { ParameterState } from './parameter-state.ts';
import { DrumHandler, InactiveHandler } from './scenes.ts';
import type { Led, SceneEvent, SceneHandler, Send, Transport } from './scenes.ts';

export { newProject, validateProject } from './model.ts';

type Handlers = { mixer: MixerHandler; empty: SceneHandler<Extract<Scene, { type: 'empty' }>>; drum: DrumHandler; fx: PerformanceFxHandler };
const pressureLedInterval = 50;
const releaseLedDelay = 200;
const drumFlashDuration = 250;
const trackActivityWindow = 8000;
const calibrationPattern = 159;
const calibrationValue = 126;
const patternSwitchDelay = 300;

function patternProgram(pattern: number): number[] {
  return pattern < 128 ? [0xc0, pattern] : [0xc1, pattern - 128];
}

function observedPattern(event: ReturnType<typeof decodeMidi>): number | null | undefined {
  if (event?.type === 'program') {
    if (event.channel === 0 && event.program <= 127) return event.program;
    if (event.channel === 1 && event.program <= 31) return 128 + event.program;
    return null;
  }
  if (event?.type === 'control' && event.controller === 103) {
    if (event.channel < 10 && event.value <= 15) return event.channel * 16 + event.value;
    return null;
  }
  return undefined;
}

export class Engine {
  private currentProject = newProject();
  scene = 0;
  private currentTransport: Transport = 'unknown';
  private readonly parameters = new ParameterState();
  readonly values = this.parameters.observed;
  readonly history = this.parameters.history;
  readonly outputValues = this.parameters.outputValues;
  private readonly latestTrackEvent = Array<number | null>(16).fill(null);
  private currentPattern: number | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  private syncPattern: number | null = null;
  private syncing = false;
  customSlots: CustomSlot[] = Array.from({ length: 16 }, () => ({ channel: 12, cc: 1, min: 0, max: 127 }));
  readonly drumFlashes = Array<number>(16).fill(0);
  private drumFlashSequence = 0;
  private readonly drumFlashTimers = new Map<number, ReturnType<typeof setTimeout>>();
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
  private readonly notify: (message: string) => void;

  constructor({ send, changed, save, notify = console.warn }: { send: Send; changed: () => void; save: (project: Project) => void; notify?: (message: string) => void }) {
    this.send = (destination, bytes) => this.parameters.sendTracked(send, destination, bytes);
    this.changed = changed;
    this.save = save;
    this.notify = notify;
    this.mixer = new MixerHandler(this.send, () => this.update());
    this.handlers = {
      mixer: this.mixer,
      empty: new InactiveHandler(),
      drum: new DrumHandler(this.send, () => this.update(true),
        (channel, cc) => cc === 15 ? this.mixer.pans[channel]
          : cc === 16 ? this.mixer.baseLevels[channel] : this.parameters.parameterValues[channel][cc - 1],
        (channel, cc, value) => {
          if (this.send('opz', [0xb0 + channel, cc, value])) {
            this.parameters.setParameter(channel, cc, value);
            this.mixer.receive({ type: 'control', channel, controller: cc, value });
          }
          this.send('iac', [0xb0 + channel, cc, cc === 16 ? this.mixer.scaledLevel(channel, value) : value]);
        }, () => this.changed()),
      fx: new PerformanceFxHandler(this.send, () => this.update(true), () => this.customSlots,
        (channel, cc, effect) => {
          const base = this.parameters.fxBase[channel][cc];
          if (effect?.type !== 'custom' && base === null) return;
          const value = effect?.type === 'custom' ? effect.value :
            Math.max(0, Math.min(127, Math.round((base ?? 0) + (effect?.value ?? 0))));
          const output = cc === 16 ? this.mixer.scaledLevel(channel, value) : value;
          if (this.parameters.lastSent[channel][cc] === output) return;
          if (this.send('iac', [0xb0 + channel, cc, output])) {
            if (cc >= 1 && cc <= 16) this.recordOutput(channel, cc, base, output);
          }
        }),
    };
  }

  get project(): Project { return this.currentProject; }
  get transport(): Transport { return this.currentTransport; }
  get held(): boolean[] { return this.controller.held; }
  get pressure(): number[] { return this.controller.pressure; }
  get pots(): readonly [number | null, number | null] { return this.controller.pots; }
  get drumVelocities(): readonly (number | null)[] { return this.handlers.drum.velocities; }
  get fxDepths(): number[] {
    const scene = this.current;
    return scene.type === 'fx' ? this.handlers.fx.depths(scene, this.controller) : Array<number>(16).fill(0);
  }
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
      case 'fx': this.handlers.fx.handle(scene, this.controller, event); break;
    }
  }

  setProject(project: unknown): void {
    if (!validateProject(project)) throw new Error('Invalid or unsupported project file');
    this.releaseAll();
    this.currentProject = project;
    if (this.current.type === 'fx') this.handlers.fx.activate(this.current, this.controller);
    this.update(true);
  }

  restoreProject(project: unknown): void {
    if (!validateProject(project)) throw new Error('Stored project has an invalid or unsupported format');
    this.currentProject = project;
    this.changed();
  }

  portDisconnected(opzInputLost: boolean): void {
    this.releaseAll();
    if (opzInputLost) this.resetOpz();
    else this.currentTransport = 'unknown';
  }

  enterCheckMode(checkController: ControllerState): void {
    this.cancelReleaseLedRefreshes();
    this.releaseAll();
    this.resetOpz();
    checkController.release();
    checkController.resetControls();
    checkController.fader = this.controller.fader;
    checkController.pots[0] = this.controller.pots[0];
    checkController.pots[1] = this.controller.pots[1];
  }

  exitCheckMode(checkController: ControllerState): void {
    this.controller.pots[0] = checkController.pots[0];
    this.controller.pots[1] = checkController.pots[1];
    this.releaseAll();
    this.refreshLeds();
  }

  setType(index: number, type: EditableSceneType): void {
    if (!Number.isInteger(index) || index < 1 || index > 15 || (type !== 'empty' && type !== 'drum' && type !== 'fx')) {
      throw new Error('Invalid scene type');
    }
    if (index === this.scene) this.releaseAll();
    this.project.scenes[index] = newScene(type);
    if (index === this.scene && this.current.type === 'fx') this.handlers.fx.activate(this.current, this.controller);
    this.update(true);
  }

  setCustomSlots(slots: unknown): void {
    if (!validateCustomSlots(slots)) throw new Error('Invalid custom performance FX slots');
    this.customSlots = structuredClone(slots);
    this.handlers.fx.recalculate();
    this.update();
  }

  setKit(index: number, kit: unknown): void {
    if (!Number.isInteger(index) || index < 1 || index > 15 || !validateDrumScene(kit)) {
      throw new Error('Invalid scene or drum kit');
    }
    if (index === this.scene) this.releaseAll();
    this.project.scenes[index] = structuredClone(kit);
    this.update(true);
  }

  releaseAll(): void {
    if (this.syncing) {
      this.cancelSync();
      this.notify('OP-Z sync cancelled.');
    }
    this.cancelPressureLeds();
    for (const timer of this.drumFlashTimers.values()) clearTimeout(timer);
    this.drumFlashTimers.clear();
    this.drumFlashes.fill(0);
    this.handlers[this.current.type].release();
    this.controller.release();
  }

  cancelReleaseLedRefreshes(): void {
    for (const timer of this.releaseLedTimers) clearTimeout(timer);
    this.releaseLedTimers.clear();
  }

  resetOpz(): void {
    this.cancelSync();
    this.currentPattern = null;
    this.currentTransport = 'unknown';
    this.latestTrackEvent.fill(null);
    this.mixer.reset();
    this.parameters.reset();
    this.update();
  }

  selectScene(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index > 15 || index === this.scene) return;
    this.releaseAll();
    this.scene = index;
    this.controller.resetControls();
    if (this.current.type === 'fx') this.handlers.fx.activate(this.current, this.controller);
    this.update();
  }

  leds(): [number, number][] {
    const scene = this.current;
    switch (scene.type) {
      case 'mixer': return this.handlers.mixer.leds(scene, this.controller);
      case 'empty': return this.handlers.empty.leds(scene, this.controller);
      case 'drum': return this.handlers.drum.leds(scene, this.controller);
      case 'fx': return this.handlers.fx.leds(scene, this.controller);
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
          if (event.on && this.current.type === 'drum') {
            clearTimeout(this.drumFlashTimers.get(event.index));
            this.drumFlashes[event.index] = ++this.drumFlashSequence;
            this.drumFlashTimers.set(event.index, setTimeout(() => {
              this.drumFlashTimers.delete(event.index);
              this.drumFlashes[event.index] = 0;
              this.changed();
            }, drumFlashDuration));
          }
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
        if (event.pressed && !this.controller.push && this.current.type === 'mixer') {
          if (this.buttons[0]) this.syncOpz();
          else if (this.transport === 'running') {
            this.mixer.guessMutes(this.latestTrackEvent.map((latest) =>
              latest === null || latest > time || time - latest > trackActivityWindow));
          }
        }
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
    const pattern = observedPattern(event);
    if (pattern !== undefined) {
      if (this.syncing && pattern !== this.syncPattern) {
        this.cancelSync();
        this.notify('OP-Z sync cancelled because the pattern changed.');
      }
      this.currentPattern = pattern;
    }
    const status = data[0];
    if (event?.type === 'transport') {
      if (event.state === 'stopped' || status === 0xfa || this.transport !== 'running') this.latestTrackEvent.fill(null);
    } else if (this.transport === 'running' && status >= 0x80 && status <= 0xef) {
      const length = (status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 2 : 3;
      if (data.length === length && Array.from(data).slice(1).every((byte) => byte >= 0 && byte < 128)) {
        this.latestTrackEvent[status & 15] = time;
      }
    }
    const forwarded = Array.from(data);
    if (event?.type === 'control') {
      this.parameters.observeBase(event.channel, event.controller, event.value);
      let value = this.current.type === 'fx' ? this.handlers.fx.value(event.channel, event.controller, event.value) : event.value;
      if (event.controller === 16) value = this.mixer.scaledLevel(event.channel, value);
      forwarded[2] = value;
    }
    this.send('iac', forwarded);
    if (!event) return;
    const previousGroup = this.mixer.group;
    this.mixer.receive(event);
    if (event.type === 'transport') {
      this.currentTransport = event.state;
      this.changed();
      this.handle({ type: 'midi', event, transport: this.transport, time });
      return;
    }
    if (event.type === 'control' && event.controller >= 1 && event.controller <= 16) {
      this.parameters.recordInput(event.channel, event.controller, event.value);
      this.recordOutput(event.channel, event.controller, event.value, forwarded[2]);
      this.changed();
    }
    this.handle({ type: 'midi', event, transport: this.transport, time });
    if (event.type === 'program' || (event.type === 'control' && [15, 16, 53, 55, 103].includes(event.controller))) {
      this.refreshLeds(this.current.type === 'mixer' && this.buttons[1] && this.mixer.group !== previousGroup);
      this.changed();
    }
  }

  private cancelSync(): void {
    clearTimeout(this.syncTimer);
    this.syncTimer = undefined;
    this.syncing = false;
    this.syncPattern = null;
  }

  private syncOpz(): void {
    if (this.syncing) {
      this.notify('OP-Z sync is already in progress.');
      return;
    }
    const previousPattern = this.currentPattern;
    if (!this.send('opz', patternProgram(calibrationPattern))) {
      this.notify('OP-Z sync failed: could not select the calibration pattern.');
      return;
    }
    this.syncing = true;
    this.syncPattern = calibrationPattern;
    this.notify('Syncing OP-Z parameter state.');
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      this.currentPattern = calibrationPattern;
      for (let channel = 0; channel < 16; channel++) {
        for (let cc = 1; cc <= 16; cc++) {
          if (!this.send('opz', [0xb0 + channel, cc, calibrationValue])) {
            this.cancelSync();
            this.resetOpz();
            this.notify('OP-Z sync failed while sending calibration values; parameter state is unknown.');
            return;
          }
          this.parameters.recordInput(channel, cc, calibrationValue);
          this.mixer.receive({ type: 'control', channel, controller: cc, value: calibrationValue });
        }
      }
      this.update();
      if (previousPattern === null || previousPattern === calibrationPattern) {
        this.cancelSync();
        this.notify('OP-Z calibration complete. Select a working pattern to finish syncing.');
        return;
      }
      this.syncTimer = setTimeout(() => {
        this.syncTimer = undefined;
        this.syncPattern = previousPattern;
        if (!this.send('opz', patternProgram(previousPattern))) {
          this.cancelSync();
          this.notify('OP-Z sync failed: could not return to the previous pattern. Select it manually.');
          return;
        }
        this.currentPattern = previousPattern;
        this.cancelSync();
        this.notify('OP-Z sync requested. Verify the working pattern and incoming parameter values.');
      }, patternSwitchDelay);
    }, patternSwitchDelay);
  }

  private recordOutput(channel: number, cc: number, before: number | null, after: number): void {
    this.parameters.recordOutput(channel, cc, before, after);
    this.changed();
  }
}
