import { Mutex } from "./utils/mutex";
import { DebugProtocol } from "@vscode/debugprotocol";
import { logger } from "@vscode/debugadapter";
import {
  GdbProxy,
  GdbBreakpoint,
  GdbBreakpointType,
  GdbBreakpointAccessType,
} from "./gdb";
import Program from "./program";
import { isDisassembledFile } from "./disassembly";

const accessTypes: Record<
  DebugProtocol.DataBreakpointAccessType,
  GdbBreakpointAccessType
> = {
  read: GdbBreakpointAccessType.READ,
  write: GdbBreakpointAccessType.WRITE,
  readWrite: GdbBreakpointAccessType.READWRITE,
};

/**
 * Breakpoint manager
 *
 * Handles adding and removing breakpoints to program
 */
export class BreakpointManager {
  /** Size map */
  private static sizes = new Map<string, number>();
  /** Default selection mask for exception : each bit is a exception code */
  static readonly DEFAULT_EXCEPTION_MASK = 0b111100;
  /** exception mask */
  private exceptionMask = BreakpointManager.DEFAULT_EXCEPTION_MASK;
  /** Breakpoints selected */
  private breakpoints: GdbBreakpoint[] = [];
  /** Pending breakpoint not yet sent to debugger */
  private pendingBreakpoints: GdbBreakpoint[] = [];
  /** Debug information for the loaded program */
  private program?: Program;
  /** Next breakpoint id - used to assign unique IDs to created breakpoints */
  private nextBreakpointId = 0;
  /** Temporary breakpoints arrays */
  private temporaryBreakpointArrays: GdbBreakpoint[][] = [];
  /** Mutex to just have one call to gdb */
  protected mutex = new Mutex(100, 180000);
  /** Lock for breakpoint management function */
  protected breakpointLock?: () => void;

  public constructor(private gdbProxy: GdbProxy) {
    gdbProxy.onFirstStop(this.sendAllPendingBreakpoints);
  }

  // Setters:

  /**
   * Set exception mask
   */
  public setExceptionMask(exceptionMask: number): BreakpointManager {
    this.exceptionMask = exceptionMask;
    return this;
  }

  /**
   * Set program
   */
  public setProgram(program: Program): BreakpointManager {
    this.program = program;
    return this;
  }

  /**
   * Set the mutex timeout
   * @param timeout Mutex timeout
   */
  public setMutexTimeout(timeout: number): void {
    this.mutex = new Mutex(100, timeout);
  }

  /**
   * Set breakpoint
   *
   * Breakpoint will be sent to the program if ready and can be resolved, otherwise added to pending array.
   *
   * @returns Added immediately?
   */
  public async setBreakpoint(bp: GdbBreakpoint): Promise<boolean> {
    if (!this.gdbProxy.isConnected()) {
      this.addPendingBreakpoint(bp);
      return false;
    }
    const isData = bp.breakpointType === GdbBreakpointType.DATA;
    const isInstruction = bp.breakpointType === GdbBreakpointType.INSTRUCTION;
    const hasMask = bp.exceptionMask !== undefined;

    try {
      if (bp.source && bp.line !== undefined && bp.id !== undefined) {
        bp.verified = false;
        const path = bp.source.path ?? "";

        if (!this.program) {
          throw new Error("Program is not running");
        }

        if (!isDisassembledFile(path)) {
          if (await this.addLocation(bp, path, bp.line)) {
            await this.gdbProxy.setBreakpoint(bp);
            this.breakpoints.push(bp);
          } else {
            throw new Error("Segment offset not resolved");
          }
        } else {
          const name = bp.source.name ?? "";
          const address = await this.program.getAddressForFileEditorLine(
            name,
            bp.line
          );
          bp.segmentId = undefined;
          bp.offset = address;
          await this.gdbProxy.setBreakpoint(bp);
          this.breakpoints.push(bp);
        }
      } else if (hasMask || isData || isInstruction) {
        await this.gdbProxy.setBreakpoint(bp);
        if (!hasMask) {
          this.breakpoints.push(bp);
        }
      } else {
        throw new Error("Breakpoint info incomplete");
      }
    } catch (error) {
      this.addPendingBreakpoint(bp, error instanceof Error ? error : undefined);
      return false;
    }
    return true;
  }

  // Pending breakpoints:
  // If a breakpoint can't be added to the program yet e.g. because the program hasn't started or the breakpoint can't
  // be resolved, it's added to an array to be sent later.

  /**
   * Add a breakpoint to be sent when the program is ready
   *
   * @param breakpoint Breakpoint to add
   * @param err Error the prevented the breakpoint being added immediately
   */
  public addPendingBreakpoint(breakpoint: GdbBreakpoint, err?: Error): void {
    breakpoint.verified = false;
    if (err) {
      breakpoint.message = err.message;
    }
    this.pendingBreakpoints.push(breakpoint);
  }

  /**
   * Get pending breakpoints array
   */
  public getPendingBreakpoints(): GdbBreakpoint[] {
    return this.pendingBreakpoints;
  }

  /**
   * Add segment and offset to pending breakpoints
   */
  public async addLocationToPending(): Promise<void> {
    if (!this.program) {
      return;
    }
    for (const bp of this.pendingBreakpoints) {
      if (bp.source && bp.line) {
        const path = bp.source.path ?? "";
        if (!isDisassembledFile(path)) {
          await this.addLocation(bp, path, bp.line);
        }
      }
    }
  }

  /**
   * Send pending breakpoints to program
   */
  public sendAllPendingBreakpoints = async (): Promise<void> => {
    if (this.pendingBreakpoints.length > 0) {
      await this.acquireLock();
      const pending = this.pendingBreakpoints;
      this.pendingBreakpoints = [];
      await Promise.all(pending.map((bp) => this.setBreakpoint(bp)));
      this.releaseLock();
    }
  };

  // Breakpoint factories:

  /**
   * Create a new source breakpoint object
   */
  public createBreakpoint(
    source: DebugProtocol.Source,
    line: number
  ): GdbBreakpoint {
    return {
      breakpointType: GdbBreakpointType.SOURCE,
      id: this.nextBreakpointId++,
      line,
      source,
      verified: false,
      offset: 0,
    };
  }

  /**
   * Create a new temporary breakpoint object
   */
  public createTemporaryBreakpoint(address: number): GdbBreakpoint {
    return {
      breakpointType: GdbBreakpointType.TEMPORARY,
      id: this.nextBreakpointId++,
      offset: address,
      temporary: true,
      verified: false,
    };
  }

  /**
   * Create a new instruction breakpoint object
   */
  public createInstructionBreakpoint(address: number): GdbBreakpoint {
    return {
      breakpointType: GdbBreakpointType.INSTRUCTION,
      id: this.nextBreakpointId++,
      offset: address,
      temporary: false,
      verified: false,
    };
  }

  /**
   * Create a new data breakpoint object
   */
  public createDataBreakpoint(
    offset: number,
    size: number,
    accessType: DebugProtocol.DataBreakpointAccessType = "readWrite",
    message?: string
  ): GdbBreakpoint {
    return {
      breakpointType: GdbBreakpointType.DATA,
      id: this.nextBreakpointId++,
      offset,
      verified: false,
      size: size,
      accessType: accessTypes[accessType],
      message,
      defaultMessage: message,
    };
  }

  public createExceptionBreakpoint(): GdbBreakpoint {
    return {
      breakpointType: GdbBreakpointType.EXCEPTION,
      id: this.nextBreakpointId++,
      exceptionMask: this.exceptionMask,
      verified: false,
      offset: 0,
    };
  }

  // Exception breakpoints:

  /**
   * Ask for an exception breakpoint
   */
  public setExceptionBreakpoint(): Promise<boolean> {
    const breakpoint = this.createExceptionBreakpoint();
    return this.setBreakpoint(breakpoint);
  }

  /**
   * Ask to remove an exception breakpoint
   */
  public async removeExceptionBreakpoint(): Promise<void> {
    await this.acquireLock();
    const breakpoint = this.createExceptionBreakpoint();
    try {
      await this.gdbProxy.removeBreakpoint(breakpoint);
    } finally {
      this.releaseLock();
    }
  }

  // Clearing breakpoints:

  /**
   * Clear source breakpoints
   */
  public clearBreakpoints(source: DebugProtocol.Source): Promise<void> {
    return this.clearBreakpointsType(GdbBreakpointType.SOURCE, source);
  }

  /**
   * Clear data breakpoints
   */
  public clearDataBreakpoints(): Promise<void> {
    return this.clearBreakpointsType(GdbBreakpointType.DATA);
  }

  /**
   * Clear instruction breakpoints
   */
  public clearInstructionBreakpoints(): Promise<void> {
    return this.clearBreakpointsType(GdbBreakpointType.INSTRUCTION);
  }

  private async clearBreakpointsType(
    type: GdbBreakpointType,
    source?: DebugProtocol.Source
  ): Promise<void> {
    let hasError = false;
    const remainingBreakpoints = [];
    await this.acquireLock();

    for (const bp of this.breakpoints) {
      const isCorrectType = bp.breakpointType === type;
      const isSameSource =
        source && bp.source && this.isSameSource(bp.source, source);

      if (isCorrectType && (!source || isSameSource)) {
        try {
          await this.gdbProxy.removeBreakpoint(bp);
        } catch (err) {
          remainingBreakpoints.push(bp);
          hasError = true;
        }
      } else {
        remainingBreakpoints.push(bp);
      }
    }
    this.breakpoints = remainingBreakpoints;

    this.releaseLock();
    if (hasError) {
      throw new Error("Some breakpoints cannot be removed");
    }
  }

  // Temporary breakpoints (used for WinUAE):

  public async addTemporaryBreakpointArray(
    tmpBreakpoints: GdbBreakpoint[]
  ): Promise<void> {
    this.temporaryBreakpointArrays.push(tmpBreakpoints);
    await Promise.all(
      tmpBreakpoints.map((bp) => this.gdbProxy.setBreakpoint(bp))
    );
  }

  /**
   * Remove temporary breakpoints which contain PC address
   */
  public async checkTemporaryBreakpoints(pc: number): Promise<void> {
    await Promise.all(
      this.temporaryBreakpointArrays
        .filter((bps) => bps.some((bp) => bp.offset === pc))
        .map((bps) => this.removeTemporaryBreakpointArray(bps))
    );
  }

  public async removeTemporaryBreakpointArray(
    tmpBreakpoints: GdbBreakpoint[]
  ): Promise<void> {
    try {
      await this.acquireLock();
      await Promise.all(
        tmpBreakpoints.map((bp) => this.gdbProxy.removeBreakpoint(bp))
      );
      this.temporaryBreakpointArrays = this.temporaryBreakpointArrays.filter(
        (item) => item !== tmpBreakpoints
      );
    } finally {
      this.releaseLock();
    }
  }

  public createTemporaryBreakpointArray(
    offsets: Array<number>
  ): GdbBreakpoint[] {
    return offsets.map((o) => this.createTemporaryBreakpoint(o));
  }

  // Utils:

  private isSameSource(
    source: DebugProtocol.Source,
    other: DebugProtocol.Source
  ): boolean {
    return (
      (source.path !== undefined && source.path === other.path) ||
      (source.name !== undefined &&
        isDisassembledFile(source.name) &&
        source.name === other.name)
    );
  }

  /**
   * Adds segmentId and offset properties to a breakpoint
   *
   * @return successfully added location?
   */
  private async addLocation(
    breakpoint: GdbBreakpoint,
    path: string,
    line: number
  ): Promise<boolean> {
    if (this.program) {
      const location = await this.program.findLocationForLine(path, line);
      if (location) {
        breakpoint.segmentId = location.segmentId;
        breakpoint.offset = location.offset;
        return true;
      }
    }
    return false;
  }

  private async acquireLock() {
    this.breakpointLock = await this.mutex.capture("breakpointLock");
  }

  private releaseLock() {
    if (this.breakpointLock) {
      this.breakpointLock();
      this.breakpointLock = undefined;
    }
  }

  // Breakpoint sizes TODO

  public static getSizeForDataBreakpoint(id: string): number | undefined {
    const size = BreakpointManager.sizes.get(id);
    logger.log(
      `[BreakpointManager] GET size of DataBreakpoint id: ${id}=${size}`
    );
    return size;
  }

  public static setSizeForDataBreakpoint(id: string, size: number) {
    logger.log(
      `[BreakpointManager] SET size of DataBreakpoint id: ${id}=${size}`
    );
    BreakpointManager.sizes.set(id, size);
  }

  public static removeSizeForDataBreakpoint(id: string) {
    logger.log(`[BreakpointManager] Removing DataBreakpoint id: ${id}`);
    BreakpointManager.sizes.delete(id);
  }
}
