#!/usr/bin/env tsx

const command = process.argv.splice(2, 1)[0];

switch (command) {
  case "-v":
  case "--version": {
    await import("../package.json").then(({version}: any) => console.log(version));
    break;
  }
  case "build":
    await import("../src/build.js").then((build) => build.build());
    break;
  case "preview":
    await import("../src/preview.js");
    break;
  case "auth":
    import("../src/auth.js");
    break;
  default:
    console.error(`Usage: observable <command>`);
    console.error(`   build\tgenerate a static site`);
    console.error(`   preview\trun the live preview server`);
    // "auth" is short enough that the tab that follows up doesn't align with
    // the other commands. The trailing space makes it line up.
    console.error(`   auth \tmanage authentication with the Observable Cloud`);
    console.error(` --version\tprint the version`);
    process.exit(1);
    break;
}
