import type { NextConfig } from "next";
import path from "path";

// Ensure Git Bash, Terraform, and AWS CLI in user space take priority on Windows
if (process.platform === "win32") {
  const localAppData = process.env.LOCALAPPDATA || "";
  const gitBin = path.join(localAppData, "Programs", "Git", "bin");
  const gitUsrBin = path.join(localAppData, "Programs", "Git", "usr", "bin");
  const gitCmd = path.join(localAppData, "Programs", "Git", "cmd");
  const terraformBin = path.join(localAppData, "Programs", "Terraform");
  const awsBin = path.join(localAppData, "Programs", "AWSCLIV2", "Amazon", "AWSCLIV2");

  process.env.PATH = `${gitBin};${gitUsrBin};${gitCmd};${terraformBin};${awsBin};${process.env.PATH}`;
}

// Ensure AWS SDK loads SSO sessions and profiles from ~/.aws/config
process.env.AWS_SDK_LOAD_CONFIG = "1";

const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;
