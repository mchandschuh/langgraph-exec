/** Public library entrypoint for phase-one direct YAML LLM execution. */
export const PACKAGE_NAME = 'langgraph-exec' as const;
export const PACKAGE_VERSION = '0.2.0' as const;

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
export { compileGraphFile, componentRegistry, GRAPH_SCHEMA, GraphDefinitionError, parseGraphDefinition } from './graph.js';
export type {
  CompletionService,
  NodeDefinition,
  NodeInput,
  ParameterDefinition,
  ParameterType,
  PortDefinition,
} from './node.js';
export type { CompiledGraph, ComponentPort, GraphBinding, GraphCompileOptions, GraphComponent, GraphDefinition, GraphEdge, GraphImport, GraphNodeInstance, GraphPort, GraphRoute, GraphStateField } from './graph.js';