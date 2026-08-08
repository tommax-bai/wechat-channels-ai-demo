import type {
  ReplyModelInput,
  ReplyModelResult,
  ReplyProvider,
} from "../types.js";

export interface ReplyModel {
  generate(input: ReplyModelInput): Promise<ReplyModelResult>;
}

export type ReplyModelRegistry = Readonly<Record<ReplyProvider, ReplyModel>>;

export class ModelError extends Error {
  constructor(
    readonly code: string,
    readonly requestId?: string,
  ) {
    super(code);
    this.name = "ModelError";
  }
}
