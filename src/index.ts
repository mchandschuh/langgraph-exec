/** Public library entrypoint for phase-one direct YAML LLM execution. */
export const PACKAGE_NAME = 'langgraph-exec' as const;
export const PACKAGE_VERSION = '0.1.0' as const;

export {
  NODE_IMPLEMENTATION,
  NODE_SCHEMA,
  NodeDefinitionError,
  defaultCompletionService,
  executeNode,
  inspectNode,
  parseNodeDefinition,
  resolveRequest,
} from './node.js';
export type {
  CompletionService,
  NodeDefinition,
  NodeInput,
  ParameterDefinition,
  ParameterType,
  PortDefinition,
} from './node.js';