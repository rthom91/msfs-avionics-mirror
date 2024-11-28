import { SimVarValueType } from '../../data/SimVars';
import { NavSourceType } from '../../instruments/NavProcessor';
import { MathUtils } from '../../math/MathUtils';
import { Accessible } from '../../sub/Accessible';
import { Subject } from '../../sub/Subject';
import { Value } from '../../sub/Value';
import { APValues } from '../APValues';
import { LNavRollSteerComputer, LNavRollSteerComputerDataProvider } from '../lnav/LNavRollSteerComputer';
import { LNavRollSteerCommand, LNavSteerCommand } from '../lnav/LNavTypes';
import { DirectorState, PlaneDirector } from './PlaneDirector';

/**
 * A steering command for {@link APGpsSteerDirector}.
 */
export type APGpsSteerDirectorSteerCommand = {
  /** Whether this command is valid. */
  isValid: boolean;

  /** Whether this command is attempting to steer toward a heading instead of a track. */
  isHeading: boolean;

  /**
   * The true course to steer, in degrees. If `isHeading` is true, then this value can be interpreted as the true
   * heading to steer instead.
   */
  courseToSteer: number;

  /**
   * The radius of the track toward which the command is attempting to steer, in great-arc radians. A radius of
   * `pi / 2` indicates the track is a great circle. A radius less than `pi / 2` indicates the track turns to the left.
   * A radius greater than `pi / 2` indicates the track turns to the right. Ignored if `isHeading` is true.
   */
  trackRadius: number;

  /** The current desired true track, in degrees. Ignored if `isHeading` is true. */
  dtk: number;

  /**
   * The current cross-track error, in nautical miles. Positive values indicate that the plane is to the right of the
   * desired track. Ignored if `isHeading` is true.
   */
  xtk: number;

  /**
   * The current track angle error, in degrees in the range `[-180, 180)`. If `isHeading` is true, then this value is
   * interpreted as the heading error instead.
   */
  tae: number;
};

/**
 * An object describing the state of an {@link APGpsSteerDirector}.
 */
export type APGpsSteerDirectorState = {
  /** The current GPS steering command used by the director. */
  gpsSteerCommand: Readonly<APGpsSteerDirectorSteerCommand>;

  /** The current roll-steering command generated by the director. */
  rollSteerCommand: Readonly<LNavRollSteerCommand> | null;
};

/**
 * Options for {@link APGpsSteerDirector}.
 */
export type APGpsSteerDirectorOptions = {
  /**
   * The maximum bank angle, in degrees, supported by the director, or a function which returns it. If not defined,
   * the director will use the maximum bank angle defined by its parent autopilot (via `apValues`). Defaults to
   * `undefined`.
   */
  maxBankAngle?: number | (() => number) | undefined;

  /**
   * The bank rate to enforce when the director commands changes in bank angle, in degrees per second, or a function
   * which returns it. If not undefined, a default bank rate will be used. Defaults to `undefined`.
   */
  bankRate?: number | (() => number) | undefined;

  /**
   * A function that determines whether the director can remain active once it has already been activated.
   * @param apValues Autopilot values from the director's parent autopilot.
   * @param state Data describing the state of the director.
   * @returns Whether the director can remain active once it has already been activated.
   */
  canArm?: (apValues: APValues, state: Readonly<APGpsSteerDirectorState>) => boolean;

  /**
   * A function that determines whether the director can remain active once it has already been activated.
   * @param apValues Autopilot values from the director's parent autopilot.
   * @param state Data describing the state of the director.
   * @returns Whether the director can remain active once it has already been activated.
   */
  canRemainArmed?: (apValues: APValues, state: Readonly<APGpsSteerDirectorState>) => boolean;

  /**
   * A function that determines whether the director can activate from an armed state.
   * @param apValues Autopilot values from the director's parent autopilot.
   * @param state Data describing the state of the director.
   * @returns Whether the director can remain active once it has already been activated.
   */
  canActivate?: (apValues: APValues, state: Readonly<APGpsSteerDirectorState>) => boolean;

  /**
   * A function that determines whether the director can remain active once it has already been activated.
   * @param apValues Autopilot values from the director's parent autopilot.
   * @param state Data describing the state of the director.
   * @returns Whether the director can remain active once it has already been activated.
   */
  canRemainActive?: (apValues: APValues, state: Readonly<APGpsSteerDirectorState>) => boolean;
};

/**
 * An autopilot GPS roll-steering director. This director converts GPS steering commands into roll-steering commands
 * in order to drive flight director bank commands. This director also sets the `AUTOPILOT NAV1 LOCK` SimVar state to
 * true (1) when it is armed or activated, and to false (0) when it is deactivated.
 */
export class APGpsSteerDirector implements PlaneDirector {
  public state: DirectorState;

  /** @inheritDoc */
  public onActivate?: () => void;

  /** @inheritDoc */
  public onArm?: () => void;

  /** @inheritDoc */
  public onDeactivate?: () => void;

  /** @inheritDoc */
  public driveBank?: (bank: number, rate?: number) => void;

  private readonly isNavLock = Subject.create<boolean>(false);

  private readonly callbackState: APGpsSteerDirectorState = {
    gpsSteerCommand: this.steerCommand.get(),
    rollSteerCommand: null
  };

  private readonly maxBankAngleFunc: () => number;
  private readonly driveBankFunc: (bank: number) => void;

  private readonly canArmFunc: (apValues: APValues, state: Readonly<APGpsSteerDirectorState>) => boolean;
  private readonly canRemainArmedFunc: (apValues: APValues, state: Readonly<APGpsSteerDirectorState>) => boolean;
  private readonly canActivateFunc: (apValues: APValues, state: Readonly<APGpsSteerDirectorState>) => boolean;
  private readonly canRemainActiveFunc: (apValues: APValues, state: Readonly<APGpsSteerDirectorState>) => boolean;

  private readonly lnavRollSteerComputerDataProvider: DirectorLNavRollSteerComputerDataProvider;
  private readonly lnavRollSteerComputer: LNavRollSteerComputer;

  /**
   * Creates a new instance of APGpsSteerDirector.
   * @param apValues Autopilot values from this director's parent autopilot.
   * @param steerCommand The steering command used by this director.
   * @param options Options to configure the new director.
   */
  public constructor(
    private readonly apValues: APValues,
    private readonly steerCommand: Accessible<Readonly<APGpsSteerDirectorSteerCommand>>,
    options?: Readonly<APGpsSteerDirectorOptions>
  ) {

    const maxBankAngleOpt = options?.maxBankAngle ?? undefined;
    switch (typeof maxBankAngleOpt) {
      case 'number':
        this.maxBankAngleFunc = () => maxBankAngleOpt;
        break;
      case 'function':
        this.maxBankAngleFunc = maxBankAngleOpt;
        break;
      default:
        this.maxBankAngleFunc = this.apValues.maxBankAngle.get.bind(this.apValues.maxBankAngle);
    }

    const bankRateOpt = options?.bankRate;
    switch (typeof bankRateOpt) {
      case 'number':
        this.driveBankFunc = bank => {
          if (isFinite(bank) && this.driveBank) {
            this.driveBank(bank, bankRateOpt * this.apValues.simRate.get());
          }
        };
        break;
      case 'function':
        this.driveBankFunc = bank => {
          if (isFinite(bank) && this.driveBank) {
            this.driveBank(bank, bankRateOpt() * this.apValues.simRate.get());
          }
        };
        break;
      default:
        this.driveBankFunc = bank => {
          if (isFinite(bank) && this.driveBank) {
            this.driveBank(bank);
          }
        };
    }

    this.canArmFunc = options?.canArm ?? ((apValuesInner, state) => state.gpsSteerCommand.isValid);
    this.canRemainArmedFunc = options?.canRemainArmed ?? ((apValuesInner, state) => state.gpsSteerCommand.isValid);
    this.canActivateFunc = options?.canActivate ?? ((apValuesInner, state) => state.rollSteerCommand !== null && state.rollSteerCommand.isValid);
    this.canRemainActiveFunc = options?.canRemainActive ?? ((apValuesInner, state) => {
      return state.rollSteerCommand !== null
        && state.rollSteerCommand.isValid
        && (
          apValuesInner.cdiSource.get()?.type === NavSourceType.Gps
          || !!apValuesInner.navToNavTransferInProgress?.()
        );
    });

    this.lnavRollSteerComputerDataProvider = new DirectorLNavRollSteerComputerDataProvider(this.steerCommand);
    this.lnavRollSteerComputer = new LNavRollSteerComputer(
      this.lnavRollSteerComputerDataProvider,
      {
        maxBankAngle: this.maxBankAngleFunc
      }
    );

    this.isNavLock.sub(newState => {
      SimVar.SetSimVarValue('AUTOPILOT NAV1 LOCK', SimVarValueType.Bool, newState);
    });

    this.state = DirectorState.Inactive;
  }

  /** @inheritDoc */
  public activate(): void {
    this.state = DirectorState.Active;
    this.onActivate && this.onActivate();
    this.isNavLock.set(true);
  }

  /** @inheritDoc */
  public arm(): void {
    if (this.state === DirectorState.Inactive) {
      this.updateCallbackState(null);
      if (this.canArmFunc(this.apValues, this.callbackState)) {
        this.state = DirectorState.Armed;
        this.onArm && this.onArm();
        this.isNavLock.set(true);
      }
    }
  }

  /** @inheritDoc */
  public deactivate(): void {
    this.state = DirectorState.Inactive;
    this.onDeactivate && this.onDeactivate();
    this.isNavLock.set(false);
    this.lnavRollSteerComputer.reset();
  }

  /** @inheritDoc */
  public update(): void {
    this.lnavRollSteerComputerDataProvider.update();
    this.lnavRollSteerComputer.update(Date.now());
    this.updateCallbackState(this.lnavRollSteerComputer.steerCommand.get());

    if (this.state === DirectorState.Armed) {
      if (!this.canRemainArmedFunc(this.apValues, this.callbackState)) {
        this.deactivate();
        return;
      } else {
        this.tryActivate();
      }
    }
    if (this.state === DirectorState.Active) {
      if (!this.canRemainActiveFunc(this.apValues, this.callbackState)) {
        this.deactivate();
        return;
      } else {
        const rollSteerCommand = this.lnavRollSteerComputer.steerCommand.get();

        if (rollSteerCommand.isValid && isFinite(rollSteerCommand.desiredBankAngle)) {
          this.driveBankFunc(rollSteerCommand.desiredBankAngle);
        }
      }
    }
  }

  /**
   * Updates this director's callback state.
   * @param rollSteerCommand The roll steering command to write to the callback state.
   */
  private updateCallbackState(rollSteerCommand: Readonly<LNavRollSteerCommand> | null): void {
    this.callbackState.gpsSteerCommand = this.steerCommand.get();
    this.callbackState.rollSteerCommand = rollSteerCommand;
  }

  /**
   * Attempts to activate this director from an armed state.
   */
  private tryActivate(): void {
    if (this.canActivateFunc(this.apValues, this.callbackState)) {
      this.activate();
    }
  }
}

/**
 * An implementation of {@link LNavRollSteerComputerDataProvider} used by {@link APGpsSteerDirector}.
 */
class DirectorLNavRollSteerComputerDataProvider implements LNavRollSteerComputerDataProvider {
  // TODO: Move this stuff into a central data provider for the autopilot.
  private readonly velocityXSimVarId = SimVar.GetRegisteredId('VELOCITY WORLD X', SimVarValueType.Knots, '');
  private readonly velocityZSimVarId = SimVar.GetRegisteredId('VELOCITY WORLD Z', SimVarValueType.Knots, '');

  private readonly headingSimVarId = SimVar.GetRegisteredId('PLANE HEADING DEGREES TRUE', SimVarValueType.Degree, '');

  /** @inheritDoc */
  public readonly lnavSteerCommand: Accessible<Readonly<LNavSteerCommand>>;

  private readonly _gs = Value.create<number | null>(null);
  /** @inheritDoc */
  public readonly gs = this._gs as Accessible<number | null>;

  private readonly _track = Value.create<number | null>(null);
  /** @inheritDoc */
  public readonly track = this._track as Accessible<number | null>;

  private readonly _heading = Value.create<number | null>(null);
  /** @inheritDoc */
  public readonly heading = this._heading as Accessible<number | null>;

  /**
   * Creates a new instance of DirectorLNavRollSteerComputerDataProvider.
   * @param steerCommand The LNAV steering command from which this provider sources data.
   */
  public constructor(steerCommand: Accessible<Readonly<APGpsSteerDirectorSteerCommand>>) {
    this.lnavSteerCommand = steerCommand;
  }

  /**
   * Updates this provider's data.
   */
  public update(): void {
    let heading: number | undefined;

    const velocityEW = SimVar.GetSimVarValueFastReg(this.velocityXSimVarId);
    const velocityNS = SimVar.GetSimVarValueFastReg(this.velocityZSimVarId);

    const gs = Math.hypot(velocityEW, velocityNS);
    this._gs.set(gs);

    if (gs > 1) {
      this._track.set(MathUtils.normalizeAngleDeg(Math.atan2(velocityEW, velocityNS) * Avionics.Utils.RAD2DEG));
    } else {
      this._track.set(heading = SimVar.GetSimVarValueFastReg(this.headingSimVarId));
    }

    this._heading.set(heading ?? SimVar.GetSimVarValueFastReg(this.headingSimVarId));
  }
}
