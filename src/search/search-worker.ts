import { SearchEngine } from './engine.js';
import type { SearchWorkerRequest, SearchWorkerResponse, SearchWorkerValue } from './worker-protocol.js';

const engine = new SearchEngine();

type WorkerScope = {
  postMessage(message: SearchWorkerResponse): void;
  onmessage: ((event: MessageEvent<SearchWorkerRequest>) => void) | null;
};

const scope = self as unknown as WorkerScope;

function execute(request: SearchWorkerRequest): SearchWorkerValue {
  switch (request.kind) {
    case 'clear':
      engine.clear();
      return null;
    case 'upsertBatch':
      for (const input of request.inputs) engine.upsertInput(input);
      return request.inputs.length;
    case 'removeBatch':
      for (const entryId of request.entryIds) engine.remove(entryId);
      return request.entryIds.length;
    case 'metadataBatch':
      for (const update of request.updates) engine.updateMetadata(update);
      return request.updates.length;
    case 'search':
      return engine.search(request.query, request.limit);
    case 'quick':
      return engine.quickSwitch(request.query, request.recent, request.limit);
    case 'facets':
      return engine.facets();
    case 'stats':
      return engine.stats();
  }
}

scope.onmessage = event => {
  const request = event.data;
  try {
    scope.postMessage({ id: request.id, ok: true, value: execute(request) });
  } catch (error) {
    scope.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : 'Search worker failed.',
    });
  }
};
