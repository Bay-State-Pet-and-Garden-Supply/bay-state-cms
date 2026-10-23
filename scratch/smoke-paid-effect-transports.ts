#!/usr/bin/env bun
import { runComparisonBudgetCoordinatorSmoke } from './comparison-budget';

const result = await runComparisonBudgetCoordinatorSmoke();
console.log(JSON.stringify({ smoke: 'paid-effect-transport-budget', ...result }, null, 2));
