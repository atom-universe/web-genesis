const path = require("path");
const fs = require("fs");
const tapable = require("tapable");
const Parser = require("./Parser.js");

/** Initialize plugins and apply them to the compiler */
function initPlugins() {
  const compiler = this;
  // Bind each plugin's 'this' context to the compiler instance
  this.plugins?.forEach((plugin) => {
    if (typeof plugin === "function") {
      plugin.call(compiler, compiler);
    } else {
      // Call the plugin's apply method with the compiler instance
      plugin.apply(compiler);
    }
  });
}

/** Generate bundle code from the dependency graph */
function generate(graph) {
  // Create a self-executing function that can run the bundled code
  // Replace module system globals with our own implementations
  const bundle = `
  ;(function(graph, moduleId) {
    
    function localRequire(relativePath) {
      return globalRequire(graph[moduleId].dependencies[relativePath]);
    }

    function globalRequire(moduleId) {
      var globalExports = {};

      ;(function(require, exports, code) {
        eval(code);
      })(localRequire, globalExports, graph[moduleId].code);
    
      return globalExports;
    }

    globalRequire(moduleId);
  })(${JSON.stringify(graph)}, ${JSON.stringify(this.entry)})`;

  // Write the bundle to the output directory
  fs.mkdirSync(this.output.path, { recursive: true });
  const filePath = path.posix.join(this.output.path, this.output.filename);
  fs.writeFileSync(filePath, bundle);
}

/** Process a module file and extract its metadata */
function build(filename) {
  // Apply loaders to transform the source code
  let code = fs.readFileSync(filename, {
    encoding: "utf-8",
  });

  this.loaders?.forEach((loader) => {
    const { test, use: loaderFunction } = loader;
    // Check if file matches loader test pattern
    if (test.test(filename)) {
      if (Array.isArray(loaderFunction)) {
        // Apply loaders in reverse order
        use.traverse().forEach((loaderFunction) => {
          code = loaderFunction(code);
        });
      } else {
        code = loaderFunction(code);
      }
    }
  });

  const { getAst, getDependencies, getCode } = Parser;
  const ast = getAst(code);
  const dependencies = getDependencies(ast, filename);
  code = getCode(ast);

  return {
    filename,
    dependencies,
    code,
  };
}

// TODO: Refactor to follow single responsibility principle
/** Start the compilation process and build dependency graph */
function run() {
  const info = this.build(this.entry);
  this.modules.push(info);

  this.hooks.compilation.call(this);
  this.hooks.make.callAsync(this, () => {
    console.log("hook make");
  });

  // TODO: Move dependency resolution to make phase
  // Build dependency graph using depth-first traversal
  this.modules.forEach((obj) => {
    // Skip already processed modules
    const isRepeated = this.modules.includes(obj.filename);
    if (!isRepeated) {
      Object.keys(obj.dependencies).forEach((key) => {
        const dependency = obj.dependencies[key];
        const module = this.build(dependency);
        this.modules.push(module);
      });
    }
  });
  // Convert modules array to dependency graph object
  const dependencyGraph = this.modules.reduce(
    (graph, item) => ({
      ...graph,
      [item.filename]: {
        dependencies: item.dependencies,
        code: item.code,
      },
    }),
    {}
  );
  // Generate bundle from dependency graph
  this.generate(dependencyGraph);

  this.hooks.emit.callAsync(this, () => {
    console.log("hook emit");
  });
  // TODO: Implement file writing in emit phase
  this.hooks.afterEmit.callAsync(this, () => {
    console.log("hook afterEmit");
  });
}

function Compiler(config) {
  this.entry = config.entry;
  this.output = config.output;
  this.plugins = config.module.plugins;
  this.loaders = config.module.rules ?? [];
  this.modules = [];
  /*
    Initialize tapable hooks for plugin system.
    Each hook receives the compiler instance as a parameter.
    Plugins can tap into these hooks to extend compilation behavior.
  */
  this.hooks = {
    compilation: new tapable.SyncHook(["compiler"]),
    make: new tapable.AsyncParallelHook(["compiler"]),
    emit: new tapable.AsyncSeriesHook(["compiler"]),
    afterEmit: new tapable.AsyncSeriesHook(["compiler"]),
  };

  this.initPlugins();
}

Compiler.prototype.run = run;
Compiler.prototype.build = build;
Compiler.prototype.generate = generate;
Compiler.prototype.initPlugins = initPlugins;

module.exports = Compiler;
