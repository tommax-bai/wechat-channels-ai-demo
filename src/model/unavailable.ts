import { ModelError, type ReplyModel } from "./reply-model.js";

export class UnavailableReplyModel implements ReplyModel {
  constructor(private readonly code = "ark_api_key_missing") {}

  async generate(): Promise<never> {
    throw new ModelError(this.code);
  }
}
