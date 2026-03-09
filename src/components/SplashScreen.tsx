import { Box } from "@mantine/core";
import claudyLogo from "../assets/claudy-logo.svg";

export default function SplashScreen() {
  return (
    <Box className="splash-screen" aria-label="Claudy splash screen">
      <Box className="splash-screen__halo splash-screen__halo--outer" />
      <Box className="splash-screen__halo splash-screen__halo--inner" />
      <Box className="splash-screen__logo-wrap">
        <Box component="img" src={claudyLogo} alt="Claudy" className="splash-screen__logo" />
      </Box>
    </Box>
  );
}
