export { RegisterFile } from './cpu/registers.js';
export { MEMORY_MAP, PERIPHERAL_BASE, regionAt } from './soc/memmap.js';
export type { MemoryRegionName, MemRegion, PeripheralName } from './soc/memmap.js';
export { ESP32_CAM, ESP32_DEVKIT_C_V4, ESP32_DEVKIT_V1 } from './boards/index.js';
export type { BoardDefinition, PinAssignment, PinRole } from './boards/index.js';
