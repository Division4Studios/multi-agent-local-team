import type { ModelShape, ServiceModel } from './model';

export const findShape = (model: ServiceModel, id: string): ModelShape | undefined => {
  const pending = [model.shapes];
  for (const group of pending) {
    for (const table of group.tables) {
      if (Object.hasOwn(table, id)) {
        return table[id];
      }
    }
    pending.push(...group.children);
  }
  return undefined;
};
