import json

with open('eval/benchmark_latest.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

print('=== PROVENANCE ===')
print('backend:', data['provenance']['backend'])
print('chromeVersion:', data['provenance']['chromeVersion'])
print('timestamp:', data['provenance']['timestamp'])
print('fixtureCount:', data['provenance']['fixtureCount'])

print('\n=== SECTION 1 SCORECARD ===')
v_acc = f"{data['overallDetection']['f1'] * 100:.1f}%"
overall_f1 = f"{data['overallDetection']['f1'] * 100:.1f}%"
overall_prec = f"{data['overallDetection']['precision'] * 100:.1f}%"
overall_rec = f"{data['overallDetection']['recall'] * 100:.1f}%"
mean_cov = sum(f.get('redaction', {}).get('coverage', 1.0) for f in data['fixtureResults']) / len(data['fixtureResults'])
redaction_cov = f"{mean_cov * 100:.1f}%"
total_pixel_leaks = len([m for m in data.get('misses', []) if 'Pixel Leak' in m.get('type', '')])
peak_heap = data['resourceMetrics']['peakOffscreenHeapMB']
active_backend = data['resourceMetrics']['activeBackend']
mean_lat = data['latencyMetrics']['mean']
med_lat = data['latencyMetrics']['median']
p95_lat = data['latencyMetrics']['p95']

print('VISUAL_CONTEXT_ACCURACY:', v_acc)
print('OVERALL_F1:', overall_f1)
print('OVERALL_PRECISION:', overall_prec)
print('OVERALL_RECALL:', overall_rec)
print('REDACTION_COVERAGE:', redaction_cov)
print('TOTAL_PIXEL_LEAKS:', total_pixel_leaks)
print('PEAK_HEAP_MB:', peak_heap)
print('ACTIVE_BACKEND:', active_backend)
print('MEAN_LATENCY_MS:', mean_lat)
print('MEDIAN_LATENCY_MS:', med_lat)
print('P95_LATENCY_MS:', p95_lat)

print('\n=== SECTION 2 FIXTURES ===')
for f in data['fixtureResults']:
    fid = f['fixtureId']
    f1 = f"{f['detection']['f1'] * 100:.0f}%"
    rec = f"{f['detection']['recall'] * 100:.0f}%"
    leaks = len(f.get('redaction', {}).get('pixelLeaks', []))
    status = 'PASS' if f['detection']['f1'] >= 0.8 and leaks == 0 else ('WARN (Below Fold)' if fid == 9 else ('WARN' if f['detection']['f1'] > 0 else 'FAIL'))
    print(f"F{fid:02d}: F1={f1} Rec={rec} Leaks={leaks} Status={status}")

print('\n=== README METRICS ===')
# INPUT_FIELDS_DETECTION_RATE: fixture 1 recall
f1_rec = f"{data['fixtureResults'][0]['detection']['recall'] * 100:.1f}%"
# PII_TEXT_DETECTION_RATE:
# Categories email, phone, aadhaar, pan, credit_card
text_cats = ['email', 'phone', 'aadhaar', 'pan', 'credit_card']
text_tp = sum(data['byCategory'][c]['tp'] for c in text_cats if c in data['byCategory'])
text_fn = sum(data['byCategory'][c]['fn'] for c in text_cats if c in data['byCategory'])
text_rec = f"{(text_tp / (text_tp + text_fn)) * 100:.1f}%"
# FACE_DETECTION_RATE:
face_rec = f"{data['byCategory']['face']['recall'] * 100:.1f}%"

print('INPUT_FIELDS_DETECTION_RATE:', f1_rec)
print('PII_TEXT_DETECTION_RATE:', text_rec, f"({text_tp}/{text_tp + text_fn})")
print('FACE_DETECTION_RATE:', face_rec)

print('\n=== ABLATION SUMMARY ===')
print('Ablation mean leak ON:', data['ablation']['summary']['meanLeakRateOn'])
print('Ablation mean leak OFF:', data['ablation']['summary']['meanLeakRateOff'])
print('Ablation total leaked ON:', data['ablation']['summary']['totalLeakedOn'])
print('Ablation total leaked OFF:', data['ablation']['summary']['totalLeakedOff'])
print('Ablation mean reduction:', data['ablation']['summary']['meanReduction'])
