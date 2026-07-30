import type { ReplyModelInput, ReplyModelResult } from "../types.js";

export interface ReplyModel {
  generate(input: ReplyModelInput): Promise<ReplyModelResult>;
}

export class ModelError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ModelError";
  }
}
