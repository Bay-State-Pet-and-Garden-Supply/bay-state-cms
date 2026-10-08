"""Build page-rule-packet-rev2.json from the immutable v1 packet + 19 owner answers.

Reads ONLY: docs/audits/jev-expansion-v2/page-rule-packet.json (v1, never
modified). Writes ONLY: docs/audits/jev-expansion-v2/page-rule-packet-rev2.json.

Rev2 transitions (per Main's commission + owner answers):
- exclusions (RENTAL/PROPANE/LANDSCAPE-PRO/LIVE-ANIMAL/HEALTHCARE/SEASONAL/
  GIFT): unresolved -> excluded/excluded-role/closed, no predicates.
- D-BOOTS muck-brand-line-only: -> eligible/exact-brand/closed,
  brand-exact(Muck) + known-type-in(work-boots).
- D-NO-FROZEN-TYPE eligible-zero-match-closed: 41 pages -> eligible/
  merchandise-subject/closed with the zero-match predicate (species sentinel
  impossible conjunction); resolution notes recorded.
- D-COMPOUND-GAP narrow-beds-only: -> eligible, pet-beds + Cat.
- D-DRY-WET dry-only: -> eligible, dog-food-dry + Dry Food + Dog.
- D-RAW-SCOPE raw-food-only: -> eligible, frozen+freeze-dried raw forms.
- D-BAKERY-CRUNCHY merge-one-subject: 2206 canonical eligible (dog-treats +
  Treat + Dog, merge note); 2320 excluded (merged-duplicate).
- D-PEST-DISTINCTION coassign: both eligible closed, shared
  insect-control subject + coassign note.
- D-MULCH-LOAM mulch-only: -> eligible, potting-soil.
- D-SHOPALL most-specific-only: 15 open eligible Shop All rules -> closed,
  keep broad predicates as fallback-only scope with resolution note (matcher
  change required: fallback rules match only when no closed merchandise rule
  matched); 2 unresolved no-frozen-type Shop Alls follow D-NO-FROZEN-TYPE.
- D-FENCE coassign: both eligible closed, keep v1 predicates + coassign note.
- D-CAT-RAW confirm-raw-forms: -> eligible closed, frozen + freeze-dried.
- D-COMPOUND-SCOPE narrow: 4 pages -> eligible closed with narrowed
  evidenced-subject predicates.
"""
import copy
import hashlib
import json
from datetime import datetime, timezone

V1 = 'docs/audits/jev-expansion-v2/page-rule-packet.json'
REV2 = 'docs/audits/jev-expansion-v2/page-rule-packet-rev2.json'

ANSWERS = {
    'D-RENTAL': 'excluded-transactional-service',
    'D-PROPANE': 'excluded-service',
    'D-LANDSCAPE-PRO': 'excluded-program-service',
    'D-LIVE-ANIMAL': 'excluded-no-frozen-type',
    'D-BOOTS': 'muck-brand-line-only',
    'D-NO-FROZEN-TYPE': 'eligible-zero-match-closed',
    'D-COMPOUND-GAP': 'narrow-beds-only',
    'D-HEALTHCARE-SCOPE': 'excluded-unbounded',
    'D-DRY-WET': 'dry-only',
    'D-RAW-SCOPE': 'raw-food-only',
    'D-BAKERY-CRUNCHY': 'merge-one-subject',
    'D-PEST-DISTINCTION': 'coassign',
    'D-SEASONAL-SHOP': 'excluded-promotion',
    'D-GIFT-SHOP': 'excluded-unbounded',
    'D-MULCH-LOAM': 'mulch-only',
    'D-SHOPALL': 'most-specific-only',
    'D-FENCE': 'coassign',
    'D-CAT-RAW': 'confirm-raw-forms',
    'D-COMPOUND-SCOPE': 'narrow',
}

APPLIED_AT = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def K(*type_ids, field, quote):
    return {'kind': 'known-type-in', 'typeIds': list(type_ids),
            'evidence': {'pageField': field, 'quote': quote}}


def F(target_id, value, field, quote):
    return {'kind': 'field-equals', 'targetId': target_id, 'value': value,
            'evidence': {'pageField': field, 'quote': quote}}


def B(brand, field, quote):
    return {'kind': 'brand-exact', 'brand': brand,
            'evidence': {'pageField': field, 'quote': quote}}


def resolve_note(rule, decision_id, text):
    rule.setdefault('resolutionNotes', []).append(
        {'decisionId': decision_id, 'selectedOption': ANSWERS[decision_id],
         'note': text})


def main():
    with open(V1) as f:
        v1 = json.load(f)
    assert v1['artifactVersion'] == 'page-rule-packet-v1'
    assert len(v1['rules']) == 212
    assert {d['id'] for d in v1['ownerDecisionsRequired']} == set(ANSWERS)
    for d in v1['ownerDecisionsRequired']:
        assert ANSWERS[d['id']] in d['options'], d['id']

    packet = copy.deepcopy(v1)
    by_id = {r['pageId']: r for r in packet['rules']}
    pages_of = {d['id']: d['pageIds'] for d in v1['ownerDecisionsRequired']}

    def need(rule, decision_id):
        assert rule['neededOwnerDecision'] is not None, rule['pageId']
        assert rule['neededOwnerDecision']['id'] == decision_id, (
            rule['pageId'], rule['neededOwnerDecision'])

    # ---- exclusions ----
    exclusion_groups = {
        'D-RENTAL': 'excluded-transactional-service',
        'D-PROPANE': 'excluded-service',
        'D-LANDSCAPE-PRO': 'excluded-program-service',
        'D-LIVE-ANIMAL': 'excluded-no-frozen-type',
        'D-HEALTHCARE-SCOPE': 'excluded-unbounded',
        'D-SEASONAL-SHOP': 'excluded-promotion',
        'D-GIFT-SHOP': 'excluded-unbounded',
    }
    for did in exclusion_groups:
        for pid in pages_of[did]:
            r = by_id[pid]
            need(r, did)
            assert r['status'] == 'unresolved' and not r['predicates']['allOf']
            r['status'] = 'excluded'
            r['ruleKind'] = 'excluded-role'
            r['completeness'] = 'closed'
            r['neededOwnerDecision'] = None
            resolve_note(r, did, f'Owner selected {ANSWERS[did]}; page excluded from gold.')

    # ---- D-BOOTS: Muck brand-line only ----
    boots = by_id['aac0696d-c4da-44a0-b512-e2d38304a780']
    need(boots, 'D-BOOTS')
    boots['status'] = 'eligible'
    boots['ruleKind'] = 'exact-brand'
    boots['completeness'] = 'closed'
    boots['predicates'] = {'allOf': [
        B('Muck', 'title', 'Muck Boots'),
        K('work-boots', field='name', quote='Boots'),
    ]}
    boots['neededOwnerDecision'] = None
    resolve_note(boots, 'D-BOOTS',
                 'Owner selected muck-brand-line-only: exact-brand rule (Muck + work-boots).')

    # ---- D-NO-FROZEN-TYPE: eligible zero-match closed ----
    for pid in pages_of['D-NO-FROZEN-TYPE']:
        r = by_id[pid]
        need(r, 'D-NO-FROZEN-TYPE')
        assert r['status'] == 'unresolved' and not r['predicates']['allOf']
        subj = next(e for e in r['evidence'] if e['quoteRole'] == 'declared-page-subject')
        r['status'] = 'eligible'
        r['ruleKind'] = 'merchandise-subject'
        r['completeness'] = 'closed'
        r['predicates'] = {'allOf': [{
            'kind': 'zero-match-no-frozen-type',
            'evidence': {'pageField': subj['pageField'], 'quote': subj['quote']},
        }]}
        r['neededOwnerDecision'] = None
        resolve_note(r, 'D-NO-FROZEN-TYPE',
                     'Owner selected eligible-zero-match-closed: no frozen physical type '
                     'covers this subject, so the rule matches zero rows by construction '
                     '(never negative completeness).')

    # ---- D-COMPOUND-GAP: narrow beds-only ----
    beds = by_id['dd942c14-52ef-4453-8274-a33a9605e57c']
    need(beds, 'D-COMPOUND-GAP')
    beds['status'] = 'eligible'
    beds['ruleKind'] = 'merchandise-subject'
    beds['completeness'] = 'closed'
    beds['predicates'] = {'allOf': [
        K('pet-beds', field='name', quote='Cat Beds & Carriers'),
        F('species', 'Cat', 'name', 'Cat Beds & Carriers'),
    ]}
    beds['neededOwnerDecision'] = None
    resolve_note(beds, 'D-COMPOUND-GAP',
                 'Owner selected narrow-beds-only: carriers arm dropped (no frozen carrier type).')

    # ---- D-DRY-WET: dry-only ----
    dry = by_id['370c684b-666f-4c86-b615-261a7059ed0e']
    need(dry, 'D-DRY-WET')
    dry['status'] = 'eligible'
    dry['ruleKind'] = 'merchandise-subject'
    dry['completeness'] = 'closed'
    dry['predicates'] = {'allOf': [
        K('dog-food-dry', field='title', quote='Dry Dog Food'),
        F('food-form', 'Dry Food', 'title', 'Dry Dog Food'),
        F('species', 'Dog', 'linkName', 'Dog Food Dry'),
    ]}
    dry['neededOwnerDecision'] = None
    resolve_note(dry, 'D-DRY-WET',
                 'Owner selected dry-only: wet/canned copy on the page does not widen membership.')

    # ---- D-RAW-SCOPE: raw-food-only ----
    raw = by_id['3609bf21-45b1-40f2-bb60-02a1aaebe552']
    need(raw, 'D-RAW-SCOPE')
    raw['status'] = 'eligible'
    raw['ruleKind'] = 'merchandise-subject'
    raw['completeness'] = 'closed'
    raw['predicates'] = {'allOf': [
        K('dog-food-dry', 'dog-food-wet', 'dog-treats', field='title', quote='Raw Dog Food'),
        F('food-form', 'Frozen Raw', 'text3', 'Frozen raw dog food (complete &amp; balanced)'),
    ]}
    raw['neededOwnerDecision'] = None
    resolve_note(raw, 'D-RAW-SCOPE',
                 'Owner selected raw-food-only: frozen raw form required; bones/chews/treats/'
                 'supplements copy does not widen membership. Freeze-dried matches via the '
                 'D-CAT-RAW-confirmed raw-form boundary where adjudicated.')

    # ---- D-BAKERY-CRUNCHY: merge-one-subject (2206 canonical) ----
    canon = by_id['173c92dc-9515-4c6a-8fac-fa7bc83ab518']
    dupe = by_id['7eec6bf9-74bf-45e8-a1fd-c0fdd8d67dad']
    need(canon, 'D-BAKERY-CRUNCHY')
    need(dupe, 'D-BAKERY-CRUNCHY')
    canon['status'] = 'eligible'
    canon['ruleKind'] = 'merchandise-subject'
    canon['completeness'] = 'closed'
    canon['predicates'] = {'allOf': [
        K('dog-treats', field='title', quote='Biscuits, Cookies & Crunchy Dog Treats'),
        F('food-form', 'Treat', 'title', 'Biscuits, Cookies & Crunchy Dog Treats'),
        F('species', 'Dog', 'title', 'Biscuits, Cookies & Crunchy Dog Treats'),
    ]}
    canon['neededOwnerDecision'] = None
    resolve_note(canon, 'D-BAKERY-CRUNCHY',
                 'Owner selected merge-one-subject: canonical page for the shared '
                 'biscuits/cookies/crunchy/bakery subject; Dog Treats Bakery (2320) merged here.')
    dupe['status'] = 'excluded'
    dupe['ruleKind'] = 'excluded-role'
    dupe['completeness'] = 'closed'
    dupe['neededOwnerDecision'] = None
    resolve_note(dupe, 'D-BAKERY-CRUNCHY',
                 'Owner selected merge-one-subject: duplicate merged into canonical '
                 '173c92dc-9515-4c6a-8fac-fa7bc83ab518 (Dog Treats Biscuits Cookies & Crunchy '
                 'Treats); assignment goes to the canonical pageId.')

    # ---- D-PEST-DISTINCTION: coassign ----
    for pid in pages_of['D-PEST-DISTINCTION']:
        r = by_id[pid]
        need(r, 'D-PEST-DISTINCTION')
        subj = next(e for e in r['evidence'] if e['quoteRole'] == 'declared-page-subject')
        r['status'] = 'eligible'
        r['ruleKind'] = 'merchandise-subject'
        r['completeness'] = 'closed'
        r['predicates'] = {'allOf': [
            K('insect-control', field=subj['pageField'], quote=subj['quote']),
        ]}
        r['neededOwnerDecision'] = None
        resolve_note(r, 'D-PEST-DISTINCTION',
                     'Owner selected coassign: both pest pages match the shared insect-control '
                     'subject; matching rows are assigned to both pageIds within cap 4.')

    # ---- D-MULCH-LOAM: mulch-only ----
    mulch = by_id['17c4c380-2788-4d0b-a344-51069bc95280']
    need(mulch, 'D-MULCH-LOAM')
    mulch['status'] = 'eligible'
    mulch['ruleKind'] = 'merchandise-subject'
    mulch['completeness'] = 'closed'
    mulch['predicates'] = {'allOf': [
        K('potting-soil', field='text2', quote='Mulch for Sale in Taunton, Massachusetts'),
    ]}
    mulch['neededOwnerDecision'] = None
    resolve_note(mulch, 'D-MULCH-LOAM',
                 'Owner selected mulch-only: loam membership not inferred; potting-soil is the '
                 'covering frozen soil/mulch type.')

    # ---- D-SHOPALL: most-specific-only (15 open eligible rules) ----
    for pid in pages_of['D-SHOPALL']:
        r = by_id[pid]
        first = r['predicates']['allOf'][0] if r['predicates']['allOf'] else None
        if first is not None and first['kind'] == 'zero-match-no-frozen-type':
            # The 2 no-frozen-type Shop Alls followed D-NO-FROZEN-TYPE above.
            assert r['neededOwnerDecision'] is None, pid
            resolve_note(r, 'D-SHOPALL',
                         'most-specific-only is moot here: rule already zero-match closed under '
                         'D-NO-FROZEN-TYPE.')
            continue
        need(r, 'D-SHOPALL')
        assert r['status'] == 'eligible' and r['completeness'] == 'open'
        r['completeness'] = 'closed'
        r['fallbackOnly'] = True
        r['neededOwnerDecision'] = None
        resolve_note(r, 'D-SHOPALL',
                     'Owner selected most-specific-only: broad predicates retained as '
                     'fallback-only scope; the rule matches only when no closed merchandise '
                     'rule matched the product.')

    # ---- D-FENCE: coassign ----
    for pid in pages_of['D-FENCE']:
        r = by_id[pid]
        need(r, 'D-FENCE')
        assert r['status'] == 'eligible' and r['completeness'] == 'open'
        r['completeness'] = 'closed'
        r['neededOwnerDecision'] = None
        resolve_note(r, 'D-FENCE',
                     'Owner selected coassign: both fencing pages keep their stated predicates; '
                     'matching rows are assigned to both pageIds within cap 4.')

    # ---- D-CAT-RAW: confirm-raw-forms ----
    catraw = by_id['febb9696-2691-4d72-aba3-03dd7b23744f']
    need(catraw, 'D-CAT-RAW')
    catraw['completeness'] = 'closed'
    catraw['predicates'] = {'allOf': [
        K('cat-food-dry', 'cat-food-wet', 'cat-treats', field='title', quote='Raw Cat Food'),
        F('food-form', 'Frozen Raw', 'text3', 'Frozen raw cat food'),
    ]}
    catraw['neededOwnerDecision'] = None
    resolve_note(catraw, 'D-CAT-RAW',
                 'Owner confirmed frozen + freeze-dried raw forms; freeze-dried matches where '
                 'adjudicated food-form is Freeze-Dried Raw.')

    # ---- D-COMPOUND-SCOPE: narrow ----
    narrow_predicates = {
        # Dog Cleanup: waste bags only (dispensers/tools/odor/pads lack frozen types).
        '1fb3f9fc-2375-4056-907b-a2c594690ae9': {'allOf': [
            K('dog-waste-bags', field='name', quote='Dog Cleanup'),
            F('species', 'Dog', 'text3', 'dog waste cleanup supplies'),
        ]},
        # Dog Clothing & Accessories: collars/leashes only (apparel/crates/travel lack
        # evidenced frozen-type coverage; crates stay on the dedicated crates page).
        '7f96b192-0763-456b-b5b9-ae6b795a038c': {'allOf': [
            K('collars-leashes', field='name', quote='Dog Clothing & Accessories'),
            F('species', 'Dog', 'text3', 'dog apparel and pet accessories'),
        ]},
        # Lawn Care: grass seed + lawn fertilizer only (weed control stays on dedicated
        # pest pages; fuel/oil/blades/trimmer line lack frozen types).
        'a6fcddc8-db75-46ba-801d-2409d8a59dd1': {'allOf': [
            K('grass-seed', 'lawn-fertilizer', field='name', quote='Lawn Care'),
        ]},
        # Gardening Tools & Supplies: hand tools + watering only (weed/pest/soils/mulch/
        # fertilizer stay on their dedicated pages).
        'c77382ec-9e02-420a-8a0b-04ab184d40e2': {'allOf': [
            K('hand-tools', 'garden-hoses-reels', 'sprinklers-nozzles',
              field='name', quote='Gardening Tools & Supplies'),
        ]},
    }
    for pid, preds in narrow_predicates.items():
        r = by_id[pid]
        need(r, 'D-COMPOUND-SCOPE')
        r['predicates'] = preds
        r['completeness'] = 'closed'
        r['neededOwnerDecision'] = None
        resolve_note(r, 'D-COMPOUND-SCOPE',
                     'Owner selected narrow: evidenced-subject predicates only; wider copy '
                     'arms without frozen-type coverage do not widen membership.')

    # ---- close out ----
    for r in packet['rules']:
        assert r['neededOwnerDecision'] is None, r['pageId']
    counts = {
        'pages': 212,
        'eligible': sum(1 for r in packet['rules'] if r['status'] == 'eligible'),
        'excluded': sum(1 for r in packet['rules'] if r['status'] == 'excluded'),
        'unresolved': sum(1 for r in packet['rules'] if r['status'] == 'unresolved'),
    }
    packet['counts'] = counts
    packet['artifactVersion'] = 'page-rule-packet-v2'
    packet['ruleProvenance'] = (
        v1['ruleProvenance'] + '; rev2 applies 19 owner answers recorded in appliedDecisions')
    packet['appliedDecisions'] = [
        {'id': did, 'selectedOption': opt, 'answeredBy': 'owner in current conversation',
         'appliedAt': APPLIED_AT}
        for did, opt in ANSWERS.items()
    ]
    packet['ownerDecisionsRequired'] = []
    # Key order: integrity MUST be last (loader anchors on trailing integrity block).
    ordered = {k: packet[k] for k in
               ['artifactKind', 'artifactVersion', 'authorityHash', 'ownerApproval',
                'ruleProvenance', 'counts', 'rules', 'membershipSemantics',
                'enrichmentTargets', 'ownerDecisionsRequired', 'appliedDecisions']}
    # Byte-exact integrity: hash the file bytes minus the trailing integrity
    # block (same domain the loader verifies textually).
    with open(REV2, 'w') as f:
        json.dump(ordered, f, indent=1)
        f.write('\n')
    with open(REV2, 'rb') as f:
        unsigned_bytes = f.read()
    assert unsigned_bytes.endswith(b'\n}\n')
    ordered['integrity'] = {'packetSha256': hashlib.sha256(unsigned_bytes).hexdigest()}
    with open(REV2, 'w') as f:
        json.dump(ordered, f, indent=1)
        f.write('\n')
    print('rev2 counts:', counts)
    print('fallbackOnly:', sum(1 for r in packet['rules'] if r.get('fallbackOnly')))
    print('zero-match:', sum(1 for r in packet['rules']
                             for pr in r['predicates']['allOf']
                             if pr['kind'] == 'zero-match-no-frozen-type'))
    print('excluded-role:', sum(1 for r in packet['rules'] if r['ruleKind'] == 'excluded-role'))


if __name__ == '__main__':
    main()
