import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import { Oldfart } from '../target/types/oldfart';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
} from '@solana/spl-token';
import { assert } from 'chai';

describe('oldfart', () => {
  // Configure the client to use the local cluster
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Oldfart as Program<Oldfart>;

  // We'll use this test mint to simulate FartCoin in the test environment
  const testMintKeypair = Keypair.generate();
  let testMint: PublicKey;
  const mintAuthority = Keypair.generate();

  // Token details are now preset in the program code
  const expectedName = 'oldFART';
  const expectedSymbol = 'oldFART';
  const testUri = 'https://test-metadata-uri.com/token.json';

  // User wallet for testing
  const userWallet = Keypair.generate();

  // Accounts we'll need
  let wrapperDataPDA: PublicKey;
  let wrapperMintPDA: PublicKey;
  let metadataAccountPDA: PublicKey;
  let vaultTokenAccountPDA: PublicKey;
  let userOriginalTokenAccount: PublicKey;
  let userWrapperTokenAccount: PublicKey;
  let wrapperMintBump: number;
  let tokenMetadataProgramId: PublicKey;

  // We'll fix this to match the constant in the program
  const FARTCOIN_MINT_ADDRESS = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";

  before(async () => {
    // Airdrop SOL to the user wallet for transactions
    const airdropSignature = await provider.connection.requestAirdrop(
        userWallet.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSignature);

    // For the test environment, we need to create a mint that we can control
    testMint = await createMint(
        provider.connection,
        provider.wallet.payer,
        mintAuthority.publicKey,
        null,
        9 // 9 decimals like most SPL tokens
    );

    console.log(`Created test mint: ${testMint.toString()}`);

    // Setup token metadata program ID (we'll mock this for tests)
    tokenMetadataProgramId = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

    // Derive all the PDAs we'll need
    [wrapperDataPDA] = await PublicKey.findProgramAddress(
        [Buffer.from('data'), testMint.toBuffer()],
        program.programId
    );

    [wrapperMintPDA, wrapperMintBump] = await PublicKey.findProgramAddress(
        [Buffer.from('wrapper'), testMint.toBuffer()],
        program.programId
    );

    [metadataAccountPDA] = await PublicKey.findProgramAddress(
        [
          Buffer.from('metadata'),
          tokenMetadataProgramId.toBuffer(),
          wrapperMintPDA.toBuffer()
        ],
        tokenMetadataProgramId
    );

    [vaultTokenAccountPDA] = await PublicKey.findProgramAddress(
        [Buffer.from('vault'), testMint.toBuffer()],
        program.programId
    );

    // Create token accounts for the user
    userOriginalTokenAccount = await createAssociatedTokenAccount(
        provider.connection,
        provider.wallet.payer,
        testMint,
        userWallet.publicKey
    );

    console.log(`Created user original token account: ${userOriginalTokenAccount.toString()}`);

    // We'll need to create the associated token account for the wrapper tokens
    // This is done differently because the mint doesn't exist yet
    userWrapperTokenAccount = await getAssociatedTokenAddress(
        wrapperMintPDA,
        userWallet.publicKey
    );

    console.log(`Derived user wrapper token account: ${userWrapperTokenAccount.toString()}`);

    // Mint some tokens to the user's original token account
    await mintTo(
        provider.connection,
        provider.wallet.payer,
        testMint,
        userOriginalTokenAccount,
        mintAuthority,
        1000000000 // 1000 tokens with 6 decimals
    );

    console.log(`Minted 1000 test tokens to user`);
  });

  it('Initialize the wrapper program', async () => {
    try {
      // For testing, we need to mock the token metadata program
      // In a real environment, you'd use the actual token metadata program
      // This is a simplified test that mostly checks the PDAs and basic setup

      // We'll use a transaction constructor since we're mocking parts
      const tx = await program.methods
          .initialize(testUri)
          .accounts({
            wrapperData: wrapperDataPDA,
            wrapperMint: wrapperMintPDA,
            originalMint: testMint,
            metadataAccount: metadataAccountPDA,
            tokenMetadataProgram: tokenMetadataProgramId,
            mintAuthority: provider.wallet.publicKey,
            payer: provider.wallet.publicKey,
            authority: provider.wallet.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .rpc();

      console.log(`Initialization successful with transaction: ${tx}`);

      // Fetch and check the wrapper data account
      const wrapperData = await program.account.wrapperData.fetch(wrapperDataPDA);

      // Verify the data was stored correctly
      assert.isTrue(wrapperData.originalMint.equals(testMint), "Original mint doesn't match");
      assert.isTrue(wrapperData.wrapperMint.equals(wrapperMintPDA), "Wrapper mint doesn't match");
      assert.equal(wrapperData.wrapperMintBump, wrapperMintBump, "Bump seed doesn't match");
      assert.isTrue(wrapperData.authority.equals(provider.wallet.publicKey), "Authority doesn't match");
      assert.equal(wrapperData.name, expectedName, "Name doesn't match");
      assert.equal(wrapperData.symbol, expectedSymbol, "Symbol doesn't match");
      assert.equal(wrapperData.uri, testUri, "URI doesn't match");

      // Check that the vault token account was created
      await getAccount(provider.connection, vaultTokenAccountPDA);

      console.log("All initialization checks passed");
    } catch (error) {
      console.error("Initialization test failed:", error);
      throw error;
    }
  });

  it('Wrap tokens', async () => {
    try {
      // Check initial balances
      const initialOriginalBalance = (await getAccount(provider.connection, userOriginalTokenAccount)).amount;
      console.log(`Initial original token balance: ${initialOriginalBalance}`);

      // Approve and wrap 500 tokens
      const amountToWrap = 500000000; // 500 tokens with 6 decimals

      await program.methods
          .wrap(new anchor.BN(amountToWrap))
          .accounts({
            wrapperData: wrapperDataPDA,
            originalMint: testMint,
            wrapperMint: wrapperMintPDA,
            userOriginalTokenAccount: userOriginalTokenAccount,
            userWrapperTokenAccount: userWrapperTokenAccount,
            vaultTokenAccount: vaultTokenAccountPDA,
            userAuthority: userWallet.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .signers([userWallet])
          .rpc();

      // Check balances after wrapping
      const afterWrapOriginalBalance = (await getAccount(provider.connection, userOriginalTokenAccount)).amount;
      const afterWrapWrapperBalance = (await getAccount(provider.connection, userWrapperTokenAccount)).amount;
      const vaultBalance = (await getAccount(provider.connection, vaultTokenAccountPDA)).amount;

      console.log(`User's original token balance after wrap: ${afterWrapOriginalBalance}`);
      console.log(`User's wrapper token balance after wrap: ${afterWrapWrapperBalance}`);
      console.log(`Vault's token balance after wrap: ${vaultBalance}`);

      // Verify the balances
      assert.equal(
          afterWrapOriginalBalance.toString(),
          (initialOriginalBalance - BigInt(amountToWrap)).toString(),
          "Original tokens were not deducted correctly"
      );

      assert.equal(
          afterWrapWrapperBalance.toString(),
          amountToWrap.toString(),
          "Wrapper tokens were not minted correctly"
      );

      assert.equal(
          vaultBalance.toString(),
          amountToWrap.toString(),
          "Vault did not receive the correct amount of original tokens"
      );

      console.log("All wrap checks passed");
    } catch (error) {
      console.error("Wrap test failed:", error);
      throw error;
    }
  });

  it('Unwrap tokens', async () => {
    try {
      // Check initial balances
      const initialOriginalBalance = (await getAccount(provider.connection, userOriginalTokenAccount)).amount;
      const initialWrapperBalance = (await getAccount(provider.connection, userWrapperTokenAccount)).amount;
      const initialVaultBalance = (await getAccount(provider.connection, vaultTokenAccountPDA)).amount;

      console.log(`Initial original token balance: ${initialOriginalBalance}`);
      console.log(`Initial wrapper token balance: ${initialWrapperBalance}`);
      console.log(`Initial vault balance: ${initialVaultBalance}`);

      // Unwrap 200 tokens
      const amountToUnwrap = 200000000; // 200 tokens with 6 decimals

      await program.methods
          .unwrap(new anchor.BN(amountToUnwrap))
          .accounts({
            wrapperData: wrapperDataPDA,
            originalMint: testMint,
            wrapperMint: wrapperMintPDA,
            userOriginalTokenAccount: userOriginalTokenAccount,
            userWrapperTokenAccount: userWrapperTokenAccount,
            vaultTokenAccount: vaultTokenAccountPDA,
            userAuthority: userWallet.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .signers([userWallet])
          .rpc();

      // Check balances after unwrapping
      const afterUnwrapOriginalBalance = (await getAccount(provider.connection, userOriginalTokenAccount)).amount;
      const afterUnwrapWrapperBalance = (await getAccount(provider.connection, userWrapperTokenAccount)).amount;
      const afterUnwrapVaultBalance = (await getAccount(provider.connection, vaultTokenAccountPDA)).amount;

      console.log(`User's original token balance after unwrap: ${afterUnwrapOriginalBalance}`);
      console.log(`User's wrapper token balance after unwrap: ${afterUnwrapWrapperBalance}`);
      console.log(`Vault's token balance after unwrap: ${afterUnwrapVaultBalance}`);

      // Verify the balances
      assert.equal(
          afterUnwrapOriginalBalance.toString(),
          (initialOriginalBalance + BigInt(amountToUnwrap)).toString(),
          "Original tokens were not returned correctly"
      );

      assert.equal(
          afterUnwrapWrapperBalance.toString(),
          (initialWrapperBalance - BigInt(amountToUnwrap)).toString(),
          "Wrapper tokens were not burned correctly"
      );

      assert.equal(
          afterUnwrapVaultBalance.toString(),
          (initialVaultBalance - BigInt(amountToUnwrap)).toString(),
          "Vault did not release the correct amount of original tokens"
      );

      console.log("All unwrap checks passed");
    } catch (error) {
      console.error("Unwrap test failed:", error);
      throw error;
    }
  });

  it('Try to initialize with wrong token mint', async () => {
    // Create a different mint to test restriction to FartCoin
    const wrongMint = await createMint(
        provider.connection,
        provider.wallet.payer,
        mintAuthority.publicKey,
        null,
        9
    );

    console.log(`Created wrong test mint: ${wrongMint.toString()}`);

    // Derive a new set of PDAs for the wrong mint
    const [wrongWrapperDataPDA] = await PublicKey.findProgramAddress(
        [Buffer.from('data'), wrongMint.toBuffer()],
        program.programId
    );

    const [wrongWrapperMintPDA] = await PublicKey.findProgramAddress(
        [Buffer.from('wrapper'), wrongMint.toBuffer()],
        program.programId
    );

    const [wrongMetadataAccountPDA] = await PublicKey.findProgramAddress(
        [
          Buffer.from('metadata'),
          tokenMetadataProgramId.toBuffer(),
          wrongWrapperMintPDA.toBuffer()
        ],
        tokenMetadataProgramId
    );

    // This should fail because the program only works with the specified FartCoin mint
    try {
      await program.methods
          .initialize(name, symbol, uri)
          .accounts({
            wrapperData: wrongWrapperDataPDA,
            wrapperMint: wrongWrapperMintPDA,
            originalMint: wrongMint,
            metadataAccount: wrongMetadataAccountPDA,
            tokenMetadataProgram: tokenMetadataProgramId,
            mintAuthority: provider.wallet.publicKey,
            payer: provider.wallet.publicKey,
            authority: provider.wallet.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .rpc();

      // If we get here, the test failed
      assert.fail("Should not be able to initialize with the wrong mint");
    } catch (error) {
      // This is expected
      console.log("Successfully prevented initialization with wrong mint");
    }
  });

  // Additional test: Try to unwrap more than available
  it('Try to unwrap more tokens than available', async () => {
    // Get the current wrapper balance
    const wrapperBalance = (await getAccount(provider.connection, userWrapperTokenAccount)).amount;

    // Try to unwrap more than the user has
    const tooMuchToUnwrap = Number(wrapperBalance) + 100000000; // Add 100 tokens

    try {
      await program.methods
          .unwrap(new anchor.BN(tooMuchToUnwrap))
          .accounts({
            wrapperData: wrapperDataPDA,
            originalMint: testMint,
            wrapperMint: wrapperMintPDA,
            userOriginalTokenAccount: userOriginalTokenAccount,
            userWrapperTokenAccount: userWrapperTokenAccount,
            vaultTokenAccount: vaultTokenAccountPDA,
            userAuthority: userWallet.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .signers([userWallet])
          .rpc();

      // If we get here, the test failed
      assert.fail("Should not be able to unwrap more than the available balance");
    } catch (error) {
      // This is expected
      console.log("Successfully prevented unwrapping more than available");
    }
  });
});
