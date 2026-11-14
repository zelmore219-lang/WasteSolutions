import { provisionDemoAccount } from "../apps/api/src/demo-account";
provisionDemoAccount()
  .then(() =>
    console.log(
      "Isolated demo account ready: username demo / password password1",
    ),
  )
  .catch(() => {
    console.error(
      "Demo account provisioning refused or failed. No production account was created.",
    );
    process.exitCode = 1;
  });
