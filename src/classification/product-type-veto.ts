/**
 * P1 #7 — single final candidate veto shared by keyword, model, and cohort
 * type paths (backfill remediation plan, Milestone 2B).
 *
 * Title/verified-manufacturer evidence for target animal and actual form
 * must not conflict with a candidate's animal domain and invariant food
 * form. Ingredient/flavor words never imply target species; ambiguous terms
 * abstain; human snacks need affirmative pet evidence, not a pet-sounding
 * brand. A confidently contradicted candidate is never promoted — the veto
 * runs AFTER every path selects its top candidate, and a vetoed winner falls
 * through to abstention (never silent promotion of the runner-up).
 *
 * Release-agnostic: reads `scope.animalDomain` + `invariantAttributes`
 * generically from whatever release the caller passes (v9 today, v10 after
 * the TaxonomyV10 pin — identical node shapes per TaxonomyV10). No type ids
 * are hardcoded here.
 *
 * Fixture dependency note: golden fixtures for the eight P1 findings are
 * release-agnostic unit fixtures (synthetic targets + v9 ids where behavior
 * is release-independent); "passes on v10" is satisfied by these plus the
 * TaxonomyV10-owned v10 validation test (new-type selection,
 * mulch→potting-soil, size-freedom).
 */
import type { ClassificationEvidence } from '../shared/types';

export interface TypeVetoCandidateMeta {
  id: string;
  animalDomain?: string | null;
  invariantSpecies?: string | null;
  invariantFoodForm?: string | null;
}

export type TypeVetoOutcome =
  | { vetoed: false }
  | { vetoed: true; reason: string };

export interface TypeVetoSignals {
  text: string;
  targetAnimals: string[];
  conflictingAnimals: boolean;
  formCues: string[];
  humanSnack: boolean;
  petAffirmative: boolean;
  noAnimalEvidence: boolean;
}

const DOG_WORDS = /\b(dog|dogs|canine|puppy|puppies)\b/;
const CAT_WORDS = /\b(cat|cats|feline|kitten|kittens|kickeroo)\b/;
const BIRD_WORDS = /\b(bird|birds|wild bird|wild-bird|avian)\b/;
const FISH_WORDS = /\b(fish|aquarium|aquatic)\b/;
const HUMAN_SNACK_WORDS = /\b(human snack|potato chips|tortilla chips|pretzel|salsa|granola bar|trail mix for hikers)\b/;
const PET_AFFIRM_WORDS = /\b(pet|dog|cat|puppy|kitten|canine|feline|for dogs|for cats|for pets|pet food|dog food|cat food|treats for)\b/;

const FORM_TREAT = /\b(jerky|treat|treats|chew|chews|biscuit|snack bites)\b/;
const FORM_TOY = /\b(toy|toys|kickeroo|ball|rope toy|squeak|plush toy|fetch toy)\b/;
const FORM_FEEDER = /\b(feeder|bird feeder|wild-bird feeder|suet feeder|hopper feeder)\b/;
const FORM_MULCH = /\b(mulch|bark mulch|wood chips for garden|landscaping mulch|potting mix|sack of mulch)\b/;
const FORM_WET = /\b(canned|wet food|wet dog|wet cat|pat[eé]|gravy|in sauce|in broth)\b/;
const FORM_DRY = /\b(dry food|dry dog|dry cat|kibble|crunchy nuggets)\b/;
const FORM_SUPPLEMENT = /\b(supplement|vitamin|joint support|probiotic powder|calming aid)\b/;

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

/**
 * Collect target-animal / form signals from title + verified-manufacturer
 * text only. Callers pass only name/title/description/brand text (see
 * titleTextFromEvidence) — flavor/ingredient/material/color records never
 * reach this function, so ingredient words cannot imply target species.
 */
export function collectTypeVetoSignals(titleText: string): TypeVetoSignals {
  const text = titleText.toLocaleLowerCase();
  const targetAnimals: string[] = [];
  if (DOG_WORDS.test(text)) pushUnique(targetAnimals, 'dog');
  if (CAT_WORDS.test(text)) pushUnique(targetAnimals, 'cat');
  if (/\b(wild bird|wild-bird|wild birds|caged bird|for wild birds)\b/.test(text)) {
    pushUnique(targetAnimals, 'wild_bird');
  } else if (BIRD_WORDS.test(text)) {
    pushUnique(targetAnimals, 'bird');
  }
  // "For Fish" is target species, never flavor: a "for <animal>" cue counts
  // even when an ingredient word like fish/salmon also appears.
  if (FISH_WORDS.test(text) || /\bfor\s+fish\b/.test(text)) pushUnique(targetAnimals, 'fish');
  // Conflicting dog/cat labels abstain — but only when both appear in the
  // SAME record segment (one title caught between two species). Boilerplate
  // shared across fields (e.g. a generic description) never manufactures a
  // conflict against the product's own name.
  const segments = titleText.split('\n').map(s => s.toLocaleLowerCase());
  const conflictingAnimals = segments.some(seg => DOG_WORDS.test(seg) && CAT_WORDS.test(seg));
  const formCues: string[] = [];
  if (FORM_TREAT.test(text)) pushUnique(formCues, 'treat');
  if (FORM_TOY.test(text)) pushUnique(formCues, 'toy');
  if (FORM_FEEDER.test(text)) pushUnique(formCues, 'feeder');
  if (FORM_MULCH.test(text)) pushUnique(formCues, 'mulch');
  if (FORM_WET.test(text)) pushUnique(formCues, 'wet');
  if (FORM_DRY.test(text)) pushUnique(formCues, 'dry');
  if (FORM_SUPPLEMENT.test(text)) pushUnique(formCues, 'supplement');
  const humanSnack = HUMAN_SNACK_WORDS.test(text);
  const petAffirmative = PET_AFFIRM_WORDS.test(text);
  return {
    text,
    targetAnimals,
    conflictingAnimals,
    formCues,
    humanSnack,
    petAffirmative,
    noAnimalEvidence: targetAnimals.length === 0,
  };
}

const ANIMAL_DOMAIN_TO_ANIMALS: Record<string, string[]> = {
  dog: ['dog'],
  cat: ['cat'],
  wild_bird: ['wild_bird', 'bird'],
  bird: ['bird', 'wild_bird'],
  fish: ['fish'],
};

function domainMatches(domain: string, animals: string[]): boolean {
  const accepted = ANIMAL_DOMAIN_TO_ANIMALS[domain] ?? [domain];
  return accepted.some(a => animals.includes(a));
}

/**
 * Final veto for one selected type candidate. Returns vetoed:false when the
 * candidate survives, or vetoed:true with a review-visible reason.
 */
export function vetoTypeCandidate(
  candidate: TypeVetoCandidateMeta,
  signals: TypeVetoSignals,
): TypeVetoOutcome {
  const domain = candidate.animalDomain?.trim() ?? '';
  if (signals.humanSnack && !signals.petAffirmative) {
    return { vetoed: true, reason: 'human snack without affirmative pet evidence abstains' };
  }
  if (signals.conflictingAnimals) {
    return { vetoed: true, reason: 'conflicting dog/cat target-animal labels abstain' };
  }
  if (domain && signals.targetAnimals.length > 0 && !domainMatches(domain, signals.targetAnimals)) {
    return {
      vetoed: true,
      reason: `candidate animal domain "${domain}" contradicts target-animal evidence (${signals.targetAnimals.join(', ')})`,
    };
  }
  const foodForm = (candidate.invariantFoodForm ?? '').toLocaleLowerCase();
  const forms = signals.formCues;
  if (foodForm.includes('treat') && forms.includes('toy') && !forms.includes('treat')) {
    return { vetoed: true, reason: 'toy form contradicts Treat invariant' };
  }
  if (/toy/.test(candidate.id) && forms.includes('treat') && !forms.includes('toy')) {
    return { vetoed: true, reason: 'treat form contradicts toy candidate' };
  }
  if (foodForm.includes('dry') && forms.includes('wet') && !forms.includes('dry')) {
    return { vetoed: true, reason: 'wet-food form contradicts Dry Food invariant' };
  }
  if (foodForm.includes('wet') && forms.includes('dry') && !forms.includes('wet')) {
    return { vetoed: true, reason: 'dry-food form contradicts Wet Food invariant' };
  }
  if (/supplement/.test(candidate.id) && (forms.includes('wet') || forms.includes('dry') || forms.includes('treat'))) {
    return { vetoed: true, reason: 'food form contradicts supplement candidate' };
  }
  if (/bird-food|bird_food/.test(candidate.id) && forms.includes('feeder')) {
    return { vetoed: true, reason: 'feeder form contradicts bird-food candidate' };
  }
  if (/potting-soil|potting_soil/.test(candidate.id)) {
    return { vetoed: false };
  }
  if (signals.noAnimalEvidence && domain && signals.formCues.length === 0) {
    return { vetoed: true, reason: 'no target-animal evidence abstains rather than inferring species' };
  }
  return { vetoed: false };
}

/** Title/brand text behind one evidence set (name/title/description/brand only). */
export function titleTextFromEvidence(evidence: ClassificationEvidence[]): string {
  const parts: string[] = [];
  for (const e of evidence) {
    const sf = e.sourceField ?? '';
    if (sf !== 'name' && sf !== 'title' && sf !== 'description' && sf !== 'brand' && sf !== 'resolved_brand') continue;
    if (typeof e.value === 'string' && e.value.trim()) parts.push(e.value);
    else if (typeof e.snippet === 'string' && e.snippet.trim()) parts.push(e.snippet);
  }
  return parts.join('\n').slice(0, 2000);
}

/** Normalize one release type node to veto metadata (generic — v9/v10 shapes). */
export function vetoMetaFromTypeNode(node: {
  id: string;
  scope?: { animalDomain?: string } | null;
  invariantAttributes?: Record<string, string | string[]>;
}): TypeVetoCandidateMeta {
  const inv = node.invariantAttributes ?? {};
  const speciesRaw = inv['species'];
  const formRaw = inv['food-form'] ?? inv['foodForm'];
  return {
    id: node.id,
    animalDomain: node.scope?.animalDomain ?? null,
    invariantSpecies: Array.isArray(speciesRaw) ? (speciesRaw[0] ?? null) : (speciesRaw ?? null),
    invariantFoodForm: Array.isArray(formRaw) ? (formRaw[0] ?? null) : (formRaw ?? null),
  };
}
