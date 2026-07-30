import { ModelError, type ReplyModel } from "./reply-model.js";

export class UnavailableReplyModel implements ReplyModel {
  async generate(): Promise<never> {
    throw new ModelError("ark_api_key_missing");
  }
}
