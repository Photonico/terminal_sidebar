// CSS Tree exposes these focused runtime entry points; its DefinitelyTyped package
// currently publishes their function signatures through the root module only.
declare module 'css-tree/parser' { import { parse } from 'css-tree'; export default parse; }
declare module 'css-tree/generator' { import { generate } from 'css-tree'; export default generate; }
declare module 'css-tree/walker' { import { walk } from 'css-tree'; export default walk; }
