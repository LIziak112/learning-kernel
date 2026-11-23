import type { EvaluatorRegistration } from "../contracts/evaluator.ts";
import type { RegisteredResponseType } from "../contracts/response-type.ts";
import { choiceKeyEvaluator } from "./evaluators.ts";
import { booleanOrStringResponse } from "./response-types/boolean-or-string.ts";
import { choiceResponse } from "./response-types/choice.ts";
import { optionIndexArrayResponse } from "./response-types/option-index-array.ts";
import { orderedTextBlanksResponse } from "./response-types/ordered-text-blanks.ts";
import { textWithOptionalTitleResponse } from "./response-types/text-with-optional-title.ts";
import { defaultTools } from "./tools.ts";

export const defaultResponseTypes: readonly RegisteredResponseType[] = [
  choiceResponse, booleanOrStringResponse, optionIndexArrayResponse, orderedTextBlanksResponse, textWithOptionalTitleResponse,
];
export const defaultEvaluators: readonly EvaluatorRegistration[] = [choiceKeyEvaluator];
export { defaultTools };
