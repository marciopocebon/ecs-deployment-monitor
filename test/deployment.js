'use strict'

const expect = require('expect.js');
const async = require('async');
const _ = require('lodash');
const AWS = require('aws-sdk-mock');
const sinon = require('sinon');
const EventEmitter = require('events');

const helpers = require('./helpers');

var Deployment = require('../lib/deployment');
var Service = require('../lib/service');
var events = require('../lib/events');
var fixtures = require('./fixtures');

describe('Deployment', function() {
  var deployment = null;

  afterEach(() => {
    if (deployment) deployment.destroy();
  });

  afterEach(helpers.afterEach);

  it('should emit state change and set internal state', function(done) {
    var startTime = Date.now();
    var service = new EventEmitter();
    deployment = new Deployment({service: service, taskDefinitionArn: 'bla'});

    deployment.on('state', (state) => {
      expect(state).to.equal('fake');
      expect(deployment.state).to.equal('fake');
      expect(deployment.history[0].state).to.equal('fake');
      expect(deployment.history[0].transitionedAt).to.greaterThan(startTime);
      done();
    });

    deployment.setState('fake');
  });

  it('should report deployment as failed when history includes failed states', function() {
    var service = new EventEmitter();
    deployment = new Deployment({service: service, taskDefinitionArn: 'bla'});
    deployment.history.push({state: 'Created'});
    deployment.history.push({state: 'TasksStarted'});
    expect(deployment.isFailure()).to.equal(false);
    deployment.history.push({state: 'TasksFailed'});
    expect(deployment.isFailure()).to.equal(true);
  });

  it('hasState should behave correctly', function() {
    var service = new EventEmitter();
    deployment = new Deployment({service: service, taskDefinitionArn: 'bla'});
    expect(deployment.hasState('Created')).to.equal(false);
    deployment.history.push({state: 'Created'});
    expect(deployment.hasState('Created')).to.equal(true);
  });

  it('should set raw deployment after service update', function(done) {
    var service = new EventEmitter();
    service.raw = {
      deployments: [
        {
          taskDefinition: 'bla'
        }
      ]
    };

    deployment = new Deployment({service: service, taskDefinitionArn: 'bla'});
    deployment._serviceUpdated();

    expect(deployment.raw).to.eql({
      taskDefinition: 'bla'
    });
    done();
  });

  describe('Constructor', function() {
    var serviceEventListenerStub = null;
    var serviceUpdatedStub = null;

    beforeEach(() => {
      serviceEventListenerStub = sinon.stub(Deployment.prototype, "_serviceEventListener");
      serviceUpdatedStub = sinon.stub(Deployment.prototype, "_serviceUpdated");
    });

    afterEach(() => {
      serviceEventListenerStub.restore()
      serviceUpdatedStub.restore()
    });

    it('should listen for events on a service object ', function(done) {
      var service = new EventEmitter();
      deployment = new Deployment({service: service});

      service.emit('event', 'test');
      service.emit('updated');

      async.nextTick(() => {
        expect(serviceEventListenerStub.called).to.equal(true);
        expect(serviceUpdatedStub.called).to.equal(true);
        done();
      });
    });
  });

  describe('Evaluator', function() {
    var evaluatorSpyFactory = (name, result) => {
      return sinon.spy((d, cb) => {
        cb(null, result);
      });
    }

    it('should call evaluators', function(done) {
      var service = new EventEmitter();
      service.initiated = true;
      deployment = new Deployment({service: service, taskDefinitionArn: 'arn'});

      var evaluatorStubs = {
        'Usurped': evaluatorSpyFactory('Usurped', false),
        'TasksStarted': evaluatorSpyFactory('TasksStarted', false),
        'TasksFailed': evaluatorSpyFactory('TasksFailed', false)
      };

      deployment.evaluate(evaluatorStubs, (err) => {
        expect(evaluatorStubs['Usurped'].calledOnce).to.equal(true);
        expect(evaluatorStubs['TasksStarted'].calledOnce).to.equal(true);
        expect(evaluatorStubs['TasksFailed'].calledOnce).to.equal(true);
        done();
      });
    });

    it('should call setState when evaluator returns true', function(done) {
      var setStateStub = sinon.stub(Deployment.prototype, "setState").callsFake(function(state) {
        expect(state).to.equal('Usurped');
        setStateStub.restore();
        done();
      });

      var service = new EventEmitter();
      service.initiated = true;
      deployment = new Deployment({service: service, taskDefinitionArn: 'arn'});

      var evaluatorStubs = {
        'NotFound': evaluatorSpyFactory('NotFound', false),
        'Usurped': evaluatorSpyFactory('Usurped', true),
        'TasksStarted': evaluatorSpyFactory('TasksStarted', false)
      };

      deployment.evaluate(evaluatorStubs, _.noop);
    });

    it('should call evaluators only one if evaluator previouly returned true', function(done) {
      var service = new EventEmitter();
      service.initiated = true;
      deployment = new Deployment({service: service, taskDefinitionArn: 'arn'});

      var evaluatorStubs = {
        'TasksStarted': evaluatorSpyFactory('TasksStarted', true)
      };

      deployment.evaluate(evaluatorStubs, (err) => {
        deployment.evaluate(evaluatorStubs, (err) => {
          expect(evaluatorStubs['TasksStarted'].calledOnce).to.equal(true);
          done();
        });
      });
    });
  });

  describe('Service Event Listener', function() {
    it('should process a TasksStartedEvent and retain tasks', function(done) {
      var taskArn = 'arn:task';
      var service = new EventEmitter();
      deployment = new Deployment({service: service, taskDefinitionArn: taskArn});
      deployment.raw = {
        createdAt: Date.now() - 5
      }

      var event = new events.TasksStartedEvent(service, { message: 'msg' });
      event.tasks = [
        { taskArn: 1, taskDefinitionArn: taskArn, startedAt: Date.now() },
        { taskArn: 2, taskDefinitionArn: taskArn, startedAt: Date.now() }
      ];

      deployment._serviceEventListener(event);

      expect(deployment.tasksStarted).to.eql([1,2]);
      done();
    });

    it('should process a TasksStoppedEvent and record the tasks failed', function(done) {
      var taskArn = 'arn:task';
      var service = new EventEmitter();
      deployment = new Deployment({service: service, taskDefinitionArn: taskArn});
      deployment.raw = {
        createdAt: Date.now() - 5
      }

      var event = new events.TasksStoppedEvent(service, { message: 'msg' });
      event.tasks = [
        { taskArn: 1, taskDefinitionArn: taskArn, startedAt: Date.now() },
        { taskArn: 2, taskDefinitionArn: taskArn, startedAt: Date.now() }
      ];

      deployment._serviceEventListener(event);

      expect(deployment.tasksFailed).to.eql([1,2]);
      done();
    });

    it('should process a SteadyEvent and mark deployment as steady', function(done) {
      var taskArn = 'arn:task';
      var service = new EventEmitter();
      deployment = new Deployment({service: service, taskDefinitionArn: taskArn});

      var event = new events.SteadyEvent(service, { message: 'msg' });
      deployment._serviceEventListener(event);

      expect(deployment.steady).to.eql(true);
      done();
    });
  });
});
