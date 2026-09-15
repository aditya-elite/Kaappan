const assert = require('assert');
const path = require('path');

global.chrome = {
  runtime: {
    onMessage: { addListener: () => {} },
    sendMessage: () => Promise.resolve(),
  },
};
global.location = { href: 'http://localhost:8000/eval' };
global.document = {
  title: 'RearGuard PII Test',
  getElementById: () => null,
  querySelectorAll: () => [],
};

const contentModule = require(path.resolve(__dirname, '../extension/content.js'));
const { redactTextBlock, redactTextBlocks } = contentModule;

console.log('==================================================');
console.log('RearGuard PII Regex Precedence and Tokenisation Tests');
console.log('==================================================');

let testsRun = 0;
let testsPassed = 0;

function runTest(name, fn) {
  testsRun++;
  try {
    fn();
    testsPassed++;
    console.log('  [PASS] ' + name);
  } catch (err) {
    console.error('  [FAIL] ' + name + ': ' + err.message);
    throw err;
  }
}

// 1. Credit card formats
runTest('Credit card with spaces tokenizes to card_number', () => {
  const tokenMap = {};
  let counter = 0;
  const tokenize = (kind) => (match) => {
    const tok = '{{scraped_' + kind + '_' + (counter++) + '}}';
    tokenMap[tok] = match;
    return tok;
  };

  const input = 'Please charge 4111 1111 1111 1111 for the item';
  const output = redactTextBlock(input, tokenize);

  assert(output.includes('{{scraped_card_number_'), 'Expected card_number token in: ' + output);
  assert(!output.includes('{{scraped_id_number_'), 'Aadhaar token must NOT match card: ' + output);
  assert(!output.includes('1111'), 'Trailing BIN must not be exposed: ' + output);
  assert.strictEqual(Object.values(tokenMap)[0], '4111 1111 1111 1111');
});

runTest('Credit card with dashes tokenizes to card_number', () => {
  const tokenMap = {};
  let counter = 0;
  const tokenize = (kind) => (match) => {
    const tok = '{{scraped_' + kind + '_' + (counter++) + '}}';
    tokenMap[tok] = match;
    return tok;
  };

  const input = 'Card: 4111-1111-1111-1111';
  const output = redactTextBlock(input, tokenize);

  assert(output.includes('{{scraped_card_number_'), 'Expected card_number token in: ' + output);
  assert(!output.includes('{{scraped_id_number_'), 'Aadhaar token must NOT match card: ' + output);
  assert.strictEqual(Object.values(tokenMap)[0], '4111-1111-1111-1111');
});

runTest('Continuous 16-digit credit card tokenizes to card_number', () => {
  const tokenMap = {};
  let counter = 0;
  const tokenize = (kind) => (match) => {
    const tok = '{{scraped_' + kind + '_' + (counter++) + '}}';
    tokenMap[tok] = match;
    return tok;
  };

  const input = 'Card: 4111111111111111';
  const output = redactTextBlock(input, tokenize);

  assert(output.includes('{{scraped_card_number_'), 'Expected card_number token in: ' + output);
  assert(!output.includes('{{scraped_id_number_'), 'Aadhaar token must NOT match card: ' + output);
  assert.strictEqual(Object.values(tokenMap)[0], '4111111111111111');
});

// 2. Aadhaar format (12 digits)
runTest('12-digit Aadhaar number tokenizes to id_number', () => {
  const tokenMap = {};
  let counter = 0;
  const tokenize = (kind) => (match) => {
    const tok = '{{scraped_' + kind + '_' + (counter++) + '}}';
    tokenMap[tok] = match;
    return tok;
  };

  const input = 'My Aadhaar is 2345 6789 0123 for verification';
  const output = redactTextBlock(input, tokenize);

  assert(output.includes('{{scraped_id_number_'), 'Expected id_number token in: ' + output);
  assert(!output.includes('{{scraped_card_number_'), 'Card token must not match 12-digit Aadhaar: ' + output);
  assert.strictEqual(Object.values(tokenMap)[0], '2345 6789 0123');
});

// 3. Phone formats
runTest('Indian phone with +91 and spaces tokenizes to phone', () => {
  const tokenMap = {};
  let counter = 0;
  const tokenize = (kind) => (match) => {
    const tok = '{{scraped_' + kind + '_' + (counter++) + '}}';
    tokenMap[tok] = match;
    return tok;
  };

  const input = 'Contact: +91 98765 43210 immediately';
  const output = redactTextBlock(input, tokenize);

  assert(output.includes('{{scraped_phone_'), 'Expected phone token in: ' + output);
  assert.strictEqual(Object.values(tokenMap)[0], '+91 98765 43210');
});

runTest('Standard 10-digit mobile number tokenizes to phone', () => {
  const tokenMap = {};
  let counter = 0;
  const tokenize = (kind) => (match) => {
    const tok = '{{scraped_' + kind + '_' + (counter++) + '}}';
    tokenMap[tok] = match;
    return tok;
  };

  const input = 'Phone: 9876543210';
  const output = redactTextBlock(input, tokenize);

  assert(output.includes('{{scraped_phone_'), 'Expected phone token in: ' + output);
  assert.strictEqual(Object.values(tokenMap)[0], '9876543210');
});

// 4. PAN format (10 chars: 5 letters + 4 digits + 1 letter)
runTest('PAN card tokenizes to pan', () => {
  const tokenMap = {};
  let counter = 0;
  const tokenize = (kind) => (match) => {
    const tok = '{{scraped_' + kind + '_' + (counter++) + '}}';
    tokenMap[tok] = match;
    return tok;
  };

  const input = 'Permanent Account Number: ABCDE1234F';
  const output = redactTextBlock(input, tokenize);

  assert(output.includes('{{scraped_pan_'), 'Expected pan token in: ' + output);
  assert.strictEqual(Object.values(tokenMap)[0], 'ABCDE1234F');
});

// 5. Email format
runTest('Email address tokenizes to email', () => {
  const tokenMap = {};
  let counter = 0;
  const tokenize = (kind) => (match) => {
    const tok = '{{scraped_' + kind + '_' + (counter++) + '}}';
    tokenMap[tok] = match;
    return tok;
  };

  const input = 'Send summary to user@example.com please';
  const output = redactTextBlock(input, tokenize);

  assert(output.includes('{{scraped_email_'), 'Expected email token in: ' + output);
  assert.strictEqual(Object.values(tokenMap)[0], 'user@example.com');
});

// 6. Negative controls - untokenised preservation
runTest('Negative control: Order #4111 1111 1111 1111 preserved untokenised', () => {
  const tokenMap = {};
  let counter = 0;
  const tokenize = (kind) => (match) => {
    const tok = '{{scraped_' + kind + '_' + (counter++) + '}}';
    tokenMap[tok] = match;
    return tok;
  };

  const input = 'Order #4111 1111 1111 1111 has been confirmed.';
  const output = redactTextBlock(input, tokenize);

  assert.strictEqual(output, input, 'Order number must remain untokenised! Got: ' + output);
  assert.strictEqual(Object.keys(tokenMap).length, 0, 'No tokens should be generated');
});

runTest('Negative control: ISBN number preserved untokenised', () => {
  const tokenMap = {};
  let counter = 0;
  const tokenize = (kind) => (match) => {
    const tok = '{{scraped_' + kind + '_' + (counter++) + '}}';
    tokenMap[tok] = match;
    return tok;
  };

  const input = 'Catalog book under ISBN: 978-3-16-148410-0 in the library';
  const output = redactTextBlock(input, tokenize);

  assert.strictEqual(output, input, 'ISBN must remain untokenised! Got: ' + output);
  assert.strictEqual(Object.keys(tokenMap).length, 0, 'No tokens should be generated');
});

runTest('Negative control: Tracking number preserved untokenised', () => {
  const tokenMap = {};
  let counter = 0;
  const tokenize = (kind) => (match) => {
    const tok = '{{scraped_' + kind + '_' + (counter++) + '}}';
    tokenMap[tok] = match;
    return tok;
  };

  const input = 'Your package tracking #9876543210 is in transit';
  const output = redactTextBlock(input, tokenize);

  assert.strictEqual(output, input, 'Tracking number must remain untokenised! Got: ' + output);
  assert.strictEqual(Object.keys(tokenMap).length, 0, 'No tokens should be generated');
});

// 7. redactTextBlocks batch verification
runTest('redactTextBlocks processes multiple blocks with local token mapping', () => {
  const blocks = [
    'Contact user@example.com or call 9876543210',
    'Card number: 4111 1111 1111 1111',
    'Order #4111 1111 1111 1111 was shipped',
  ];

  const { redactedBlocks, localTokenMap } = redactTextBlocks(blocks);

  assert(redactedBlocks[0].includes('{{scraped_email_0}}'), 'Block 0 must have email token');
  assert(redactedBlocks[0].includes('{{scraped_phone_1}}'), 'Block 0 must have phone token');
  assert(redactedBlocks[1].includes('{{scraped_card_number_2}}'), 'Block 1 must have card token');
  assert.strictEqual(redactedBlocks[2], 'Order #4111 1111 1111 1111 was shipped', 'Block 2 must be untokenised');
  assert.strictEqual(localTokenMap['{{scraped_email_0}}'], 'user@example.com');
  assert.strictEqual(localTokenMap['{{scraped_card_number_2}}'], '4111 1111 1111 1111');
});

console.log('==================================================');
console.log('All ' + testsPassed + '/' + testsRun + ' PII regex tests PASSED cleanly.');
console.log('==================================================');