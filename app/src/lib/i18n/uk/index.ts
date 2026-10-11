// Ukrainian translations, keyed by the English text. One module per area; later modules win on duplicates.
import { automation } from "./automation";
import { common } from "./common";
import { editor } from "./editor";
import { start } from "./start";
import { exportArea } from "./export";

export const UK: Record<string, string | string[]> = {
  ...common,
  ...start,
  ...editor,
  ...automation,
  ...exportArea,
};
