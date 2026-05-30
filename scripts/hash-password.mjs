import bcrypt from "bcryptjs";

const password = process.argv[2] || process.env.DASHBOARD_PASSWORD;
if (!password) {
  throw new Error("Pass the dashboard password as the first argument or DASHBOARD_PASSWORD");
}
console.log(await bcrypt.hash(password, 14));
