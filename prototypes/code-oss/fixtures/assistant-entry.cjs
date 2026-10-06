const { startAssistantService } = require('../product/assistant/host.cjs');
const { dependencies } = require('../../shared/assistant/tests/provider-fixture.cjs');
startAssistantService({ dependencies: dependencies() });
