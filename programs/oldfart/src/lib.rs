use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};
use spl_token::instruction as token_instruction;
use mpl_token_metadata::instructions as metadata_instruction;
use std::str::FromStr;

declare_id!("AYJhUBEebntBVPvnKmNNymQHLTnQKkdKRyx8aspb3qe5");

// Fixed token mint we're wrapping (FartCoin)
const FARTCOIN_MINT: &str = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";

// Fixed metadata for oldFART
const TOKEN_NAME: &str = "oldFART";
const TOKEN_SYMBOL: &str = "oldFART";
const DEFAULT_URI: &str = "https://arweave.net/oldfart-metadata-uri";

#[program]
pub mod oldfart {
    use super::*;

    // Initialize the wrapper program
    pub fn initialize(ctx: Context<Initialize>, uri: Option<String>) -> Result<()> {
        // Generate a PDA for the wrapper token mint
        let (_wrapper_mint_pda, wrapper_mint_bump) =
            Pubkey::find_program_address(&[b"wrapper", ctx.accounts.original_mint.key().as_ref()], ctx.program_id);

        // Store bump seed for later use
        let wrapper_data = &mut ctx.accounts.wrapper_data;
        wrapper_data.original_mint = ctx.accounts.original_mint.key();
        wrapper_data.wrapper_mint = ctx.accounts.wrapper_mint.key();
        wrapper_data.wrapper_mint_bump = wrapper_mint_bump;
        wrapper_data.authority = ctx.accounts.authority.key();
        wrapper_data.name = TOKEN_NAME.to_string();
        wrapper_data.symbol = TOKEN_SYMBOL.to_string();
        wrapper_data.uri = uri.unwrap_or(DEFAULT_URI.to_string());

        // Create the wrapper token metadata with OLD metadata format (607 bytes instead of 679)
        let metadata_accounts = metadata_instruction::CreateV2CpiBuilder::new()
            .metadata(ctx.accounts.metadata_account.key())
            .mint(ctx.accounts.wrapper_mint.key())
            .authority(ctx.accounts.mint_authority.key())
            .payer(ctx.accounts.payer.key())
            .update_authority(ctx.accounts.mint_authority.key(), true)
            .name(TOKEN_NAME.to_string())
            .symbol(TOKEN_SYMBOL.to_string())
            .uri(uri.unwrap_or(DEFAULT_URI.to_string()))
            .seller_fee_basis_points(0)
            .collection_details(None)
            .token_standard(Some(mpl_token_metadata::types::TokenStandard::NonFungible))
            .instructions(ctx.accounts.system_program.to_account_info().clone())
            .build();

        invoke(
            &metadata_accounts,
            &[
                ctx.accounts.metadata_account.to_account_info(),
                ctx.accounts.wrapper_mint.to_account_info(),
                ctx.accounts.mint_authority.to_account_info(),
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.mint_authority.to_account_info(),
                ctx.accounts.token_metadata_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.rent.to_account_info(),
            ],
        )?;

        Ok(())
    }

    // Wrap original tokens into wrapper tokens
    pub fn wrap(ctx: Context<Wrap>, amount: u64) -> Result<()> {
        // Transfer original tokens from user to vault
        let transfer_to_vault_ix = token_instruction::transfer(
            ctx.accounts.token_program.key,
            &ctx.accounts.user_original_token_account.key(),
            &ctx.accounts.vault_token_account.key(),
            &ctx.accounts.user_authority.key(),
            &[],
            amount,
        )?;

        invoke(
            &transfer_to_vault_ix,
            &[
                ctx.accounts.user_original_token_account.to_account_info(),
                ctx.accounts.vault_token_account.to_account_info(),
                ctx.accounts.user_authority.to_account_info(),
            ],
        )?;

        // Mint wrapper tokens to user
        let seeds = &[
            b"wrapper",
            ctx.accounts.original_mint.key().as_ref(),
            &[ctx.accounts.wrapper_data.wrapper_mint_bump]
        ];
        let signer = &[&seeds[..]];

        let mint_to_user_ix = token_instruction::mint_to(
            ctx.accounts.token_program.key,
            &ctx.accounts.wrapper_mint.key(),
            &ctx.accounts.user_wrapper_token_account.key(),
            &ctx.accounts.wrapper_mint.key(),
            &[],
            amount,
        )?;

        invoke_signed(
            &mint_to_user_ix,
            &[
                ctx.accounts.wrapper_mint.to_account_info(),
                ctx.accounts.user_wrapper_token_account.to_account_info(),
                ctx.accounts.wrapper_mint.to_account_info(),
            ],
            signer,
        )?;

        Ok(())
    }

    // Unwrap wrapper tokens back to original tokens
    pub fn unwrap(ctx: Context<Unwrap>, amount: u64) -> Result<()> {
        // Burn wrapper tokens from user
        let burn_user_tokens_ix = token_instruction::burn(
            ctx.accounts.token_program.key,
            &ctx.accounts.user_wrapper_token_account.key(),
            &ctx.accounts.wrapper_mint.key(),
            &ctx.accounts.user_authority.key(),
            &[],
            amount,
        )?;

        invoke(
            &burn_user_tokens_ix,
            &[
                ctx.accounts.user_wrapper_token_account.to_account_info(),
                ctx.accounts.wrapper_mint.to_account_info(),
                ctx.accounts.user_authority.to_account_info(),
            ],
        )?;

        // Transfer original tokens from vault to user
        let vault_seeds = &[
            b"vault",
            ctx.accounts.original_mint.key().as_ref(),
            &[ctx.accounts.wrapper_data.wrapper_mint_bump]
        ];
        let vault_signer = &[&vault_seeds[..]];

        let transfer_from_vault_ix = token_instruction::transfer(
            ctx.accounts.token_program.key,
            &ctx.accounts.vault_token_account.key(),
            &ctx.accounts.user_original_token_account.key(),
            &ctx.accounts.program_id,
            &[],
            amount,
        )?;

        invoke_signed(
            &transfer_from_vault_ix,
            &[
                ctx.accounts.vault_token_account.to_account_info(),
                ctx.accounts.user_original_token_account.to_account_info(),
                ctx.accounts.program_id.to_account_info(),
            ],
            vault_signer,
        )?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + WrapperData::LEN,
        seeds = [b"data", original_mint.key().as_ref()],
        bump
    )]
    pub wrapper_data: Account<'info, WrapperData>,

    #[account(
        init,
        payer = payer,
        mint::decimals = original_mint.decimals,
        mint::authority = wrapper_mint,
        seeds = [b"wrapper", original_mint.key().as_ref()],
        bump
    )]
    pub wrapper_mint: Account<'info, Mint>,

    #[account(
        constraint = original_mint.key().to_string() == FARTCOIN_MINT
    )]
    pub original_mint: Account<'info, Mint>,

    /// CHECK: This is the metadata account for the wrapper token
    #[account(
        seeds = [
            b"metadata",
            token_metadata_program.key().as_ref(),
            wrapper_mint.key().as_ref()
        ],
        bump,
        seeds::program = token_metadata_program.key()
    )]
    pub metadata_account: UncheckedAccount<'info>,

    /// CHECK: This is the Token Metadata Program
    pub token_metadata_program: UncheckedAccount<'info>,

    #[account(mut)]
    pub mint_authority: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Wrap<'info> {
    #[account(
        seeds = [b"data", original_mint.key().as_ref()],
        bump
    )]
    pub wrapper_data: Account<'info, WrapperData>,

    pub original_mint: Account<'info, Mint>,

    #[account(
        seeds = [b"wrapper", original_mint.key().as_ref()],
        bump = wrapper_data.wrapper_mint_bump
    )]
    pub wrapper_mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = original_mint,
        associated_token::authority = user_authority
    )]
    pub user_original_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = wrapper_mint,
        associated_token::authority = user_authority
    )]
    pub user_wrapper_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault", original_mint.key().as_ref()],
        bump,
        token::mint = original_mint,
        token::authority = program_id
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Unwrap<'info> {
    #[account(
        seeds = [b"data", original_mint.key().as_ref()],
        bump
    )]
    pub wrapper_data: Account<'info, WrapperData>,

    pub original_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [b"wrapper", original_mint.key().as_ref()],
        bump = wrapper_data.wrapper_mint_bump
    )]
    pub wrapper_mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = original_mint,
        associated_token::authority = user_authority
    )]
    pub user_original_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = wrapper_mint,
        associated_token::authority = user_authority
    )]
    pub user_wrapper_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault", original_mint.key().as_ref()],
        bump,
        token::mint = original_mint,
        token::authority = vault_token_account
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[account]
pub struct WrapperData {
    pub original_mint: Pubkey,    // 32 bytes
    pub wrapper_mint: Pubkey,     // 32 bytes
    pub wrapper_mint_bump: u8,    // 1 byte
    pub authority: Pubkey,        // 32 bytes
    pub name: String,             // 4 + string length bytes
    pub symbol: String,           // 4 + string length bytes
    pub uri: String,              // 4 + string length bytes
}

impl WrapperData {
    // Allocate enough space for the account
    pub const LEN: usize = 32 + 32 + 1 + 32 + 4 + 32 + 4 + 10 + 4 + 200;
}
