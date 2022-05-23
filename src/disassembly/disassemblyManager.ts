import { StackFrame, Source } from "@vscode/debugadapter";
import { DebugProtocol } from "@vscode/debugprotocol";

import { disassemble } from "./cpuDisassembler";
import { GdbProxy, GdbStackPosition, GdbThread } from "../gdb";
import { disassembleCopper } from "./copperDisassembler";
import { formatAddress, formatHexadecimal, splitLines } from "../utils/strings";
import Program from "../program";

export class DisassembledFile {
  private segmentId: number | undefined;
  private stackFrameIndex: number | undefined;
  private addressExpression: string | undefined;
  private length: number | undefined;
  private copper = false;
  private path = "";

  public setPath(path: string): DisassembledFile {
    this.path = path;
    return this;
  }

  public setSegmentId(segmentId: number): DisassembledFile {
    this.segmentId = segmentId;
    return this;
  }

  public getSegmentId(): number | undefined {
    return this.segmentId;
  }

  public setStackFrameIndex(stackFrameIndex: number): DisassembledFile {
    this.stackFrameIndex = stackFrameIndex;
    return this;
  }

  public getStackFrameIndex(): number | undefined {
    return this.stackFrameIndex;
  }

  public setAddressExpression(addressExpression: string): DisassembledFile {
    this.addressExpression = addressExpression;
    return this;
  }

  public getAddressExpression(): string | undefined {
    return this.addressExpression;
  }

  public setLength(length: number): DisassembledFile {
    this.length = length;
    return this;
  }

  public getLength(): number | undefined {
    return this.length;
  }

  public isSegment(): boolean {
    return this.segmentId !== undefined;
  }

  public setCopper(isCopper: boolean): DisassembledFile {
    this.copper = isCopper;
    return this;
  }

  public isCopper(): boolean {
    return this.copper;
  }

  public toString(): string {
    if (this.isSegment()) {
      return `${this.path}seg_${this.segmentId}.dbgasm`;
    } else if (this.isCopper()) {
      return `${this.path}copper_${this.addressExpression}__${this.length}.dbgasm`;
    } else {
      return `${this.path}${this.stackFrameIndex}__${this.addressExpression}__${this.length}.dbgasm`;
    }
  }

  public static fromPath(path: string): DisassembledFile {
    const segMatch = path.match(
      /^(?<path>.+\/)?seg_(?<segmentId>[^_]+).dbgasm$/
    );
    if (segMatch?.groups) {
      const { path = "", segmentId } = segMatch.groups;
      return new DisassembledFile()
        .setPath(path)
        .setSegmentId(parseInt(segmentId));
    }

    const copperMatch = path.match(
      /^(?<path>.+\/)?copper_(?<address>[^_]+)__(?<length>[^_]+).dbgasm$/
    );
    if (copperMatch?.groups) {
      const { path = "", address, length } = copperMatch.groups;
      return new DisassembledFile()
        .setPath(path)
        .setAddressExpression(address)
        .setLength(parseInt(length))
        .setCopper(true);
    }

    const addressMatch = path.match(
      /^(?<path>.+\/)?(?<frame>[^_]+)__(?<address>[^_]+)__(?<length>[^_]+).dbgasm$/
    );
    if (addressMatch?.groups) {
      const { path = "", frame, address, length } = addressMatch.groups;
      return new DisassembledFile()
        .setPath(path)
        .setStackFrameIndex(parseInt(frame))
        .setAddressExpression(address)
        .setLength(parseInt(length));
    }

    throw new Error("Unrecognised filename format " + path);
  }

  public toURI(): string {
    // Code to replace #, it is not done by the Uri.parse
    const filename = this.toString().replace("#", "%23");
    return `disassembly:${filename}`;
  }

  public static isDebugAsmFile(path: string): boolean {
    return path.endsWith(".dbgasm");
  }
}

export interface DisassembledLine {
  text: string;
  isCopper: boolean;
}

export class DisassemblyManager {
  protected lineCache = new Map<number, DisassembledLine>();

  public constructor(private gdb: GdbProxy, private program: Program) {}

  public async disassembleLine(
    pc: number,
    thread: GdbThread
  ): Promise<DisassembledLine> {
    const cached = this.lineCache.get(pc);
    if (cached) {
      return cached;
    }

    let text = formatAddress(pc) + ": ";
    const isCopper = this.gdb.isCopperThread(thread);
    try {
      const memory = await this.gdb.getMemory(pc, 10);
      if (isCopper) {
        // Copper thread
        const lines = disassembleCopper(memory);
        text += lines[0].toString().split("    ")[0];
      } else if (this.gdb.isCPUThread(thread)) {
        // CPU thread
        const { code } = await disassemble(memory);
        const lines = splitLines(code);
        let selectedLine = lines.find((l) => l.trim().length) ?? lines[0];
        const elms = selectedLine.split("  ");
        if (elms.length > 2) {
          selectedLine = elms[2];
        }
        text += selectedLine.trim().replace(/\s\s+/g, " ");
      }
      this.lineCache.set(pc, { text, isCopper });
    } catch (err) {
      console.error("Error ignored: " + (err as Error).message);
    }

    return { text, isCopper };
  }

  public isCopperLine(pc: number): boolean {
    const cached = this.lineCache.get(pc);
    return cached?.isCopper === true;
  }

  public async getStackFrame(
    stackPosition: GdbStackPosition,
    thread: GdbThread
  ): Promise<StackFrame> {
    const stackFrameIndex = stackPosition.index;
    const address = stackPosition.pc;
    const { text: stackFrameLabel, isCopper } = await this.disassembleLine(
      address,
      thread
    );

    const dAsmFile = new DisassembledFile();
    dAsmFile
      .setCopper(isCopper)
      .setStackFrameIndex(stackFrameIndex)
      .setLength(500);

    let lineNumber = 1;
    // is the pc on a opened segment ?
    const [segmentId, offset] = this.gdb.toRelativeOffset(address);
    if (segmentId >= 0 && !isCopper) {
      // We have a segment
      dAsmFile.setSegmentId(segmentId);
      let returnedLineNumber;
      try {
        returnedLineNumber = await this.getLineNumberInDisassembledSegment(
          segmentId,
          offset
        );
      } catch (err) {
        // Nothing to do
        lineNumber = -1;
      }
      if (returnedLineNumber || returnedLineNumber === 0) {
        lineNumber = returnedLineNumber;
      }
    } else {
      let newAddress = address;
      if (isCopper) {
        // Search for selected copper list
        const cop1Addr = await this.getCopperAddress(1);
        const cop2Addr = await this.getCopperAddress(2);
        const lineInCop1 = cop1Addr
          ? Math.floor((address - cop1Addr + 4) / 4)
          : -1;
        const lineInCop2 = cop2Addr
          ? Math.floor((address - cop2Addr + 4) / 4)
          : -1;

        if (
          lineInCop1 >= 0 &&
          (lineInCop2 === -1 || lineInCop1 <= lineInCop2)
        ) {
          newAddress = cop1Addr;
          lineNumber = lineInCop1;
        } else if (lineInCop2 >= 0) {
          newAddress = cop2Addr;
          lineNumber = lineInCop2;
        }
      }
      dAsmFile.setAddressExpression(`$${newAddress.toString(16)}`);
    }

    const sf = new StackFrame(stackFrameIndex, stackFrameLabel);
    sf.instructionPointerReference = formatHexadecimal(address);

    if (lineNumber >= 0 && isCopper) {
      sf.source = new Source(dAsmFile.toString(), dAsmFile.toURI());
      sf.line = lineNumber;
      sf.column = 1;
    }

    return sf;
  }

  public async disassembleSegment(
    segmentId: number
  ): Promise<DebugProtocol.DisassembledInstruction[]> {
    // ask for memory dump
    const memory = await this.gdb.getSegmentMemory(segmentId);
    const startAddress = this.gdb.toAbsoluteOffset(segmentId, 0);
    // disassemble the code
    const { instructions } = await disassemble(memory, startAddress);
    return instructions;
  }

  public async disassembleAddress(
    addressExpression: string,
    length: number,
    offset: number | undefined,
    isCopper: boolean
  ): Promise<DebugProtocol.DisassembledInstruction[]> {
    let searchedAddress: number | undefined;
    if (isCopper && (addressExpression === "1" || addressExpression === "2")) {
      // Retrieve the copper address
      searchedAddress = await this.getCopperAddress(
        parseInt(addressExpression)
      );
    } else {
      searchedAddress = await this.program.evaluate(addressExpression);
    }
    if (searchedAddress === undefined) {
      throw new Error("Unable to resolve address expression void returned");
    }
    if (offset) {
      searchedAddress += offset;
    }
    return this.disassembleNumericalAddress(searchedAddress, length, isCopper);
  }

  public async getAddressForFileEditorLine(
    filePath: string,
    lineNumber: number
  ): Promise<number> {
    let instructions: void | DebugProtocol.DisassembledInstruction[];
    if (lineNumber > 0) {
      const dAsmFile = DisassembledFile.fromPath(filePath);
      if (dAsmFile.isSegment()) {
        const segmentId = dAsmFile.getSegmentId();
        if (segmentId !== undefined) {
          instructions = await this.disassembleSegment(segmentId);
        } else {
          throw new Error(`SegmentId undefined in path ${filePath}`);
        }
      } else {
        // Path from outside segments
        const address = dAsmFile.getAddressExpression();
        const length = dAsmFile.getLength();
        if (address !== undefined && length !== undefined) {
          instructions = await this.disassembleAddress(
            address,
            length,
            0,
            dAsmFile.isCopper()
          );
        }
      }
      if (instructions) {
        const searchedLN = lineNumber - 1;
        if (searchedLN < instructions.length) {
          return parseInt(instructions[searchedLN].address, 16);
        } else {
          throw new Error(
            `Searched line ${searchedLN} greater than file "${filePath}" length: ${instructions.length}`
          );
        }
      } else {
        throw new Error(`Searched line ${lineNumber} has no instructions`);
      }
    } else {
      throw new Error(`Invalid line number: '${lineNumber}'`);
    }
  }

  private async getLineNumberInDisassembledSegment(
    segmentId: number,
    offset: number
  ): Promise<number> {
    const memory = await this.gdb.getSegmentMemory(segmentId);
    const { instructions } = await disassemble(memory);
    const index = instructions.findIndex(
      (instr) => parseInt(instr.address) === offset
    );
    if (index === -1) {
      throw new Error(
        `Cannot retrieve line for segment ${segmentId}, offset ${offset}: line not found`
      );
    }
    return index + 1;
  }

  private async getCopperAddress(copperIndex: number): Promise<number> {
    const copperHigh = copperIndex === 1 ? 0xdff080 : 0xdff084;
    const memory = await this.gdb.getMemory(copperHigh, 4);
    return parseInt(memory, 16);
  }

  private async disassembleNumericalAddress(
    searchedAddress: number,
    length: number,
    isCopper: boolean
  ): Promise<DebugProtocol.DisassembledInstruction[]> {
    const address = searchedAddress;
    if (!this.gdb.isConnected()) {
      throw new Error("Debugger not started");
    }
    const memory = await this.gdb.getMemory(address, length);
    if (isCopper) {
      return disassembleCopper(memory).map((inst, i) => ({
        instructionBytes: inst.getInstructionBytes(),
        address: formatHexadecimal(address + i * 4),
        instruction: inst.toString(),
      }));
    } else {
      // disassemble the code
      const { instructions } = await disassemble(memory, address);
      return instructions;
    }
  }
}
