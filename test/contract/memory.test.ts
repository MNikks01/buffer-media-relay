import { createMemoryRepo } from '../fakes/memory-repo.js';
import { repoContract } from './repo.contract.js';

repoContract('in-memory', async () => createMemoryRepo());
